// ============================================================
// Nisras Barbarian Automation
// Registriert sich direkt in Midi-QOL Hooks — keine Macros nötig
// ============================================================

const MODULE_ID = "nisras-automation";
const ACTOR_NAME = "Nisras";

// ============================================================
// Hilfsfunktionen
// ============================================================

function hasEffect(actor, name) {
  return actor.effects.some(e => e.name === name && !e.disabled);
}

function getRageUses(actor) {
  const rage = actor.items.getName("Rage");
  return rage?.system.uses?.value ?? 0;
}

function isFirstAttackThisTurn(actor) {
  const last = actor.getFlag("world", "barbarianLastAttackTurn") ?? null;
  if (!last) return true;
  return last.round !== game.combat?.round || last.turn !== game.combat?.turn;
}

async function markAttackThisTurn(actor) {
  await actor.setFlag("world", "barbarianLastAttackTurn", {
    round: game.combat?.round ?? 0,
    turn: game.combat?.turn ?? 0
  });
}

function isFirstDamageThisTurn(actor) {
  const last = actor.getFlag("world", "barbarianLastDamageTurn") ?? null;
  if (!last) return true;
  return last.round !== game.combat?.round || last.turn !== game.combat?.turn;
}

async function markDamageThisTurn(actor) {
  await actor.setFlag("world", "barbarianLastDamageTurn", {
    round: game.combat?.round ?? 0,
    turn: game.combat?.turn ?? 0
  });
}

function findItemEffect(actor, name) {
  return actor.items.contents
    .flatMap(i => i.effects.contents)
    .find(e => e.name === name);
}

function hasAttackDisadvantageCondition(actor) {
  if (typeof ac5e === "undefined") return false;
  return Object.entries(ac5e.statusEffectsTables)
    .filter(([_, v]) => "attack" in (v.rules ?? {}))
    .some(([id]) => actor.statuses.has(id));
}

// ============================================================
// Dialog Hilfsfunktionen
// ============================================================

function askYesNo(title, content) {
  return new Promise(resolve => {
    new Dialog({
      title,
      content: `<p>${content}</p>`,
      buttons: {
        yes: { label: "Ja", callback: () => resolve(true) },
        no:  { label: "Nein", callback: () => resolve(false) }
      },
      default: "no",
      close: () => resolve(false)
    }).render(true);
  });
}

function askBrutalStrike() {
  return new Promise(resolve => {
    new Dialog({
      title: "Brutal Strike — Effekt wählen",
      content: `<p>Welchen Brutal Strike Zusatzeffekt möchtest du nutzen?</p>`,
      buttons: {
        forceful:  { label: "Forceful Blow",  callback: () => resolve("forceful") },
        hamstring: { label: "Hamstring Blow",  callback: () => resolve("hamstring") },
        none:      { label: "Keinen",          callback: () => resolve("none") }
      },
      default: "none",
      close: () => resolve("none")
    }).render(true);
  });
}

// ============================================================
// Hook: midi-qol.preAttackRoll — Rage + Reckless
// ============================================================

async function onPreAttackRoll(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;

  const rageActive  = hasEffect(actor, "Rage");
  const firstAttack = isFirstAttackThisTurn(actor);

  // 1. Rage-Erinnerung wenn Rage nicht aktiv aber noch Ladungen vorhanden
  if (!rageActive && firstAttack && getRageUses(actor) > 0) {
    const doRage = await askYesNo(
      "Rage aktivieren?",
      "Du hast noch Rage-Ladungen. Rage aktivieren? <em>(Bonus Action)</em>"
    );
    if (doRage) {
      const activity = actor.items.getName("Rage")?.system.activities?.contents[0];
      if (activity) {
        await activity.use({}, { configure: false }, { create: true });
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // 2. Reckless Attack fragen beim ersten Angriff wenn Rage aktiv
  if (hasEffect(actor, "Rage") && firstAttack && !hasEffect(actor, "Attacking Recklessly")) {
    const doReckless = await askYesNo(
      "Reckless Attack?",
      "Reckless Attack nutzen? Du erhältst Advantage auf diese Attacke, gibst aber Advantage auf alle Angriffe gegen dich bis zu deinem nächsten Zug."
    );
    if (doReckless) {
      const activity = actor.items.getName("Reckless Attack")?.system.activities?.contents[0];
      if (activity) {
        await activity.use({}, { configure: false }, { create: true });
        await new Promise(r => setTimeout(r, 500));
      }
      workflow.attackRollModifierTracker.advantage.add("reckless", "Reckless Attack");
    }
  }

  await markAttackThisTurn(actor);
}

// ============================================================
// Hook: midi-qol.preAttackRollConfig — Brutal Strike
// ============================================================

async function onPreAttackRollConfig(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;
  if (!hasEffect(actor, "Attacking Recklessly")) return;

  const hasAdvantage    = workflow.attackRollModifierTracker.hasAdvantage;
  const hasDisadvantage = workflow.attackRollModifierTracker.hasDisadvantage;
  if (!hasAdvantage || hasDisadvantage || hasAttackDisadvantageCondition(actor)) return;

  const doBrutal = await askYesNo(
    "Brutal Strike?",
    "Brutal Strike nutzen? Du gibst den Advantage auf diese Attacke auf."
  );
  if (!doBrutal) {
    await actor.unsetFlag("world", "barbarianBrutalStrikeChoice");
    return;
  }

  // Advantage wegnehmen
  workflow.attackRollModifierTracker.reset();
  workflow.attackRollModifierTracker.advantage.suppress("brutalStrike", "Brutal Strike");

  const choice = await askBrutalStrike();
  await actor.setFlag("world", "barbarianBrutalStrikeChoice", choice);

  // Brutal Strike Damage Effekt enablen
  const brutalEffect = findItemEffect(actor, "Reckless Attack: Brutal Strike Damage");
  if (brutalEffect) await brutalEffect.update({ disabled: false });
}

// ============================================================
// Hook: midi-qol.preDamageRoll — Frenzy + Brutal Strike Effekte
// ============================================================

async function onPreDamageRoll(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (!workflow.hitTargets?.size) return;
  console.log(`${MODULE_ID} | onPreDamageRoll gefeuert, workflow.id:`, workflow.id);
  console.trace();

  const recklessActive = hasEffect(actor, "Attacking Recklessly");
  const firstDamage    = isFirstDamageThisTurn(actor);

  // 1. Frenzy beim ersten Damage wenn Reckless aktiv
  if (recklessActive && firstDamage) {
    const activity = actor.items.getName("Frenzy")?.system.activities?.contents[0];
    if (activity) {
      await activity.use({}, { configure: false }, { create: true });
    }
    await markDamageThisTurn(actor);
  }

  // 2. Brutal Strike Effekte anwenden
  const brutalChoice = actor.getFlag("world", "barbarianBrutalStrikeChoice");
  if (!brutalChoice) return;

  const target = workflow.hitTargets.first();
  if (!target) return;

  if (brutalChoice === "forceful") {
    const gridSize = canvas.grid.size;
    const pushPx   = gridSize * 3; // 3 Felder = 15ft

    const attackerPos = { x: workflow.token.x + workflow.token.w / 2, y: workflow.token.y + workflow.token.h / 2 };
    const targetPos   = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    const dx  = targetPos.x - attackerPos.x;
    const dy  = targetPos.y - attackerPos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const newX = target.x + (dx / len) * pushPx;
    const newY = target.y + (dy / len) * pushPx;

    await actor.setFlag("world", "barbarianForcefulBlowTarget", {
      tokenUuid: target.document.uuid,
      x: newX,
      y: newY
    });

    const halfSpeed = Math.floor((actor.system.attributes.movement.walk ?? 30) / 2);
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <strong>Brutal Strike — Forceful Blow!</strong><br>
        ${target.name} soll 15ft weggestoßen werden.<br>
        Du kannst dich bis zu ${halfSpeed}ft auf das Ziel zu bewegen ohne Opportunity Attacks auszulösen.<br>
        <button class="nisras-forceful-blow-confirm" data-actor-uuid="${actor.uuid}"
                style="margin-top:6px; width:100%; cursor:pointer;">
          ✅ Push bestätigen (GM)
        </button>
      `
    });

  } else if (brutalChoice === "hamstring") {
    const existing = target.actor.effects.find(e => e.name === "Hamstring Blow");
    if (existing) await existing.delete();

    await target.actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Hamstring Blow",
      icon: "icons/skills/wounds/injury-knee-polearm-heavy.webp",
      origin: actor.uuid,
      duration: {
        rounds: 1,
        startRound: game.combat?.round,
        startTurn: game.combat?.turn
      },
      changes: [{
        key: "system.attributes.movement.walk",
        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
        value: "-15",
        priority: 20
      }]
    }]);

    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<strong>Brutal Strike — Hamstring Blow!</strong><br>
                ${target.name}'s Speed wurde um 15ft reduziert bis zum Start deines nächsten Zuges.`
    });
  }

  // Brutal Strike Effekt nach DamageRollComplete wieder disablen
  Hooks.once("midi-qol.DamageRollComplete", async (wf) => {
    if (wf.id !== workflow.id) return;
    const brutalEffect = findItemEffect(actor, "Reckless Attack: Brutal Strike Damage");
    if (brutalEffect) await brutalEffect.update({ disabled: true });
    await actor.unsetFlag("world", "barbarianBrutalStrikeChoice");
  });
}

// ============================================================
// Hook: combatTurnChange — Flags zurücksetzen
// ============================================================

async function onCombatTurnChange(combat) {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.name !== ACTOR_NAME) continue;
    await actor.unsetFlag("world", "barbarianLastAttackTurn").catch(() => {});
    await actor.unsetFlag("world", "barbarianLastDamageTurn").catch(() => {});
    await actor.unsetFlag("world", "barbarianBrutalStrikeChoice").catch(() => {});
    await actor.unsetFlag("world", "barbarianForcefulBlowTarget").catch(() => {});
  }
}

// ============================================================
// Hook: renderChatMessageHTML — Forceful Blow GM-Button
// ============================================================

function onRenderChatMessageHTML(message, html) {
  const btn = html.querySelector(".nisras-forceful-blow-confirm");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!game.user.isGM) {
      ui.notifications.warn("Nur der GM kann den Push bestätigen!");
      return;
    }
    const a = await fromUuid(btn.dataset.actorUuid);
    const flagData = a?.getFlag("world", "barbarianForcefulBlowTarget");
    if (!flagData) {
      ui.notifications.warn("Keine Zieldaten gefunden!");
      return;
    }
    const targetDoc = await fromUuid(flagData.tokenUuid);
    if (targetDoc) await targetDoc.update({ x: flagData.x, y: flagData.y });
    await a.unsetFlag("world", "barbarianForcefulBlowTarget");
    await message.delete();
    ui.notifications.info("Forceful Blow ausgeführt!");
  });
}

// ============================================================
// Modul Initialisierung
// ============================================================

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Initialisiert — registriere Hooks`);

  Hooks.on("midi-qol.preAttackRoll",       onPreAttackRoll);
  Hooks.on("midi-qol.preAttackRollConfig", onPreAttackRollConfig);
  Hooks.on("midi-qol.preDamageRoll",       onPreDamageRoll);
  Hooks.on("combatTurnChange",             onCombatTurnChange);
  Hooks.on("renderChatMessageHTML",        onRenderChatMessageHTML);

  console.log(`${MODULE_ID} | Alle Hooks registriert`);
});