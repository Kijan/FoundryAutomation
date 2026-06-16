// ============================================================
// Nisras Barbarian Automation v1.4
// ============================================================

const MODULE_ID = "nisras-automation";
const ACTOR_NAME = "Nisras";

// ============================================================
// Zustands-Variablen
// ============================================================

const state = {
  // Per-Angriff (wird bei jedem neuen Angriff zurückgesetzt)
  currentWorkflowId: null,
  preItemRollDone: false,
  preDamageDone: false,
  recklessActivated: false,
  brutalChoice: null,        // null = kein Brutal Strike, "forceful"/"hamstring"/"none" = Brutal Strike gewählt

  // Per-Zug (wird beim Rundenwechsel zurückgesetzt)
  frenzyPending: false,
  lastAttackRound: null,
  lastAttackTurn: null,

  newAttack(workflowId) {
    this.currentWorkflowId = workflowId;
    this.preItemRollDone = true;
    this.preDamageDone = false;
    this.recklessActivated = false;
    this.brutalChoice = null;
  },

  newTurn() {
    this.currentWorkflowId = null;
    this.preItemRollDone = false;
    this.preDamageDone = false;
    this.recklessActivated = false;
    this.brutalChoice = null;
    this.frenzyPending = false;
    this.lastAttackRound = null;
    this.lastAttackTurn = null;
  },

  isFirstAttack() {
    const round = game.combat?.round ?? null;
    const turn  = game.combat?.turn  ?? null;
    return this.lastAttackRound !== round || this.lastAttackTurn !== turn;
  },

  markAttack() {
    this.lastAttackRound = game.combat?.round ?? null;
    this.lastAttackTurn  = game.combat?.turn  ?? null;
  }
};

// ============================================================
// Hilfsfunktionen
// ============================================================

function hasEffect(actor, name) {
  return actor.effects.some(e => e.name === name && !e.disabled);
}

function getRageUses(actor) {
  return actor.items.getName("Rage")?.system.uses?.value ?? 0;
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
        yes: { label: "Ja",   callback: () => resolve(true) },
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
// Hook: midi-qol.preItemRoll — Alle Dialoge VOR der Chat-Karte
// ============================================================

async function onPreItemRoll({ activity, token, workflow }) {
  const actor = token?.actor;
  if (!actor || actor.name !== ACTOR_NAME) return;
  if (activity?.actionType !== "mwak") return;

  const workflowId = workflow?.id ?? activity?.uuid;

  // Guard: nur einmal pro Workflow
  if (state.preItemRollDone && state.currentWorkflowId === workflowId) {
    console.log(`${MODULE_ID} | preItemRoll | Guard aktiv, überspringe`);
    return;
  }

  console.log(`${MODULE_ID} | preItemRoll | Neuer Angriff, workflowId: ${workflowId}`);
  state.newAttack(workflowId);

  const firstAttack = state.isFirstAttack();

  // 1. Rage-Erinnerung
  if (!hasEffect(actor, "Rage") && firstAttack && getRageUses(actor) > 0) {
    const doRage = await askYesNo(
      "Rage aktivieren?",
      "Du hast noch Rage-Ladungen. Rage aktivieren? <em>(Bonus Action)</em>"
    );
    if (doRage) {
      const rageActivity = actor.items.getName("Rage")?.system.activities?.contents[0];
      if (rageActivity) {
        await rageActivity.use({}, { configure: false }, { create: true });
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // 2. Reckless Attack (nur beim ersten Angriff)
  if (hasEffect(actor, "Rage") && firstAttack && !hasEffect(actor, "Attacking Recklessly")) {
    const doReckless = await askYesNo(
      "Reckless Attack?",
      "Reckless Attack nutzen? Du erhältst Advantage auf diese Attacke, gibst aber Advantage auf alle Angriffe gegen dich bis zu deinem nächsten Zug."
    );
    if (doReckless) {
      const recklessActivity = actor.items.getName("Reckless Attack")?.system.activities?.contents[0];
      if (recklessActivity) {
        await recklessActivity.use({}, { configure: false }, { create: true });
        await new Promise(r => setTimeout(r, 500));
      }
      state.recklessActivated = true;
    }
  }

  const recklessNow = hasEffect(actor, "Attacking Recklessly") || state.recklessActivated;

  // Frenzy-Flag setzen beim ersten Angriff wenn Reckless aktiv
  if (firstAttack && recklessNow) {
    state.frenzyPending = true;
  }

  // 3. Brutal Strike — bei JEDEM Angriff wenn Reckless aktiv
  state.brutalChoice = null;
  const brutalEffect = findItemEffect(actor, "Reckless Attack: Brutal Strike Damage");
  if (brutalEffect?.disabled === false) await brutalEffect.update({ disabled: true });

  if (recklessNow && !hasAttackDisadvantageCondition(actor)) {
    const doBrutal = await askYesNo(
      "Brutal Strike?",
      "Brutal Strike nutzen? Du gibst den Advantage auf diese Attacke auf."
    );
    if (doBrutal) {
      state.brutalChoice = await askBrutalStrike();
      console.log(`${MODULE_ID} | preItemRoll | Brutal Strike gewählt: ${state.brutalChoice}`);
      if (brutalEffect) await brutalEffect.update({ disabled: false });
    }
  }

  state.markAttack();
  console.log(`${MODULE_ID} | preItemRoll | Fertig | recklessActivated: ${state.recklessActivated} | brutalChoice: ${state.brutalChoice} | frenzyPending: ${state.frenzyPending}`);
}

// ============================================================
// Hook: midi-qol.preAttackRoll — Advantage in Tracker schreiben
// ============================================================

async function onPreAttackRoll(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;

  console.log(`${MODULE_ID} | preAttackRoll | brutalChoice: ${state.brutalChoice} | recklessActivated: ${state.recklessActivated} | hasAdvantage: ${workflow.attackRollModifierTracker.hasAdvantage}`);

  if (!(hasEffect(actor, "Attacking Recklessly") || state.recklessActivated)) return;

  if (state.brutalChoice === null) {
    // Kein Brutal Strike → Advantage hinzufügen
    workflow.attackRollModifierTracker.advantage.add("reckless", "Reckless Attack");
    console.log(`${MODULE_ID} | preAttackRoll | Advantage hinzugefügt`);
  }
  // Bei Brutal Strike: suppress läuft in preAttackRollConfig nach checkAttackAdvantage
}

// ============================================================
// Hook: midi-qol.preAttackRollConfig — Brutal Strike Advantage supprimieren
// ============================================================

async function onPreAttackRollConfig(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;

  console.log(`${MODULE_ID} | preAttackRollConfig | brutalChoice: ${state.brutalChoice} | hasAdvantage: ${workflow.attackRollModifierTracker.hasAdvantage}`);

  if (state.brutalChoice !== null) {
    workflow.attackRollModifierTracker.advantage.suppress("brutalStrike", "Brutal Strike");
    console.log(`${MODULE_ID} | preAttackRollConfig | Advantage supprimiert | hasAdvantage after: ${workflow.attackRollModifierTracker.hasAdvantage}`);
  }
}

// ============================================================
// Hook: midi-qol.AttackRollComplete — Brutal Effect bei Miss disablen
// ============================================================

async function onAttackRollComplete(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;

  if (!workflow.hitTargets?.size && state.brutalChoice !== null) {
    console.log(`${MODULE_ID} | AttackRollComplete | Miss — Brutal Effect disablen`);
    const brutalEffect = findItemEffect(actor, "Reckless Attack: Brutal Strike Damage");
    if (brutalEffect?.disabled === false) await brutalEffect.update({ disabled: true });
    state.brutalChoice = null;
  }
}

// ============================================================
// Hook: midi-qol.preDamageRoll — Frenzy + Brutal Strike Effekte
// ============================================================

async function onPreDamageRoll(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (!workflow.hitTargets?.size) return;

  // Nur mwak Haupt-Workflow
  if (workflow.activity?.actionType !== "mwak") return;

  // Guard: nur einmal pro Workflow-ID
  if (state.preDamageDone && state.currentWorkflowId === workflow.id) return;
  state.preDamageDone = true;

  console.log(`${MODULE_ID} | preDamageRoll | brutalChoice: ${state.brutalChoice} | frenzyPending: ${state.frenzyPending}`);

  const recklessActive = hasEffect(actor, "Attacking Recklessly");

  // 1. Frenzy beim ersten Treffer
  if (recklessActive && state.frenzyPending) {
    const activity = actor.items.getName("Frenzy")?.system.activities?.contents[0];
    if (activity) {
      await activity.use({}, { configure: false }, { create: true });
    }
    state.frenzyPending = false;
    console.log(`${MODULE_ID} | preDamageRoll | Frenzy ausgelöst`);
  }

  // 2. Brutal Strike Effekte
  if (!state.brutalChoice) return;

  const target = workflow.hitTargets.first();
  if (!target) return;

  if (state.brutalChoice === "forceful") {
    const gridSize = canvas.grid.size;
    const pushPx   = gridSize * 3;

    const attackerPos = { x: workflow.token.x + workflow.token.w / 2, y: workflow.token.y + workflow.token.h / 2 };
    const targetPos   = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    const dx  = targetPos.x - attackerPos.x;
    const dy  = targetPos.y - attackerPos.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    await actor.setFlag("world", "barbarianForcefulBlowTarget", {
      tokenUuid: target.document.uuid,
      x: target.x + (dx / len) * pushPx,
      y: target.y + (dy / len) * pushPx
    });

    const halfSpeed = Math.floor((actor.system.attributes.movement.walk ?? 30) / 2);
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <strong>Brutal Strike — Forceful Blow!</strong><br>
        ${target.name} soll 15ft weggestoßen werden.<br>
        Du kannst dich bis zu ${halfSpeed}ft auf das Ziel zu bewegen ohne Opportunity Attacks.<br>
        <button class="nisras-forceful-blow-confirm" data-actor-uuid="${actor.uuid}"
                style="margin-top:6px; width:100%; cursor:pointer;">
          ✅ Push bestätigen (GM)
        </button>
      `
    });

  } else if (state.brutalChoice === "hamstring") {
    const existing = target.actor.effects.find(e => e.name === "Hamstring Blow");
    if (existing) await existing.delete();

    await target.actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Hamstring Blow",
      icon: "icons/skills/wounds/injury-knee-polearm-heavy.webp",
      origin: actor.uuid,
      duration: { rounds: 1, startRound: game.combat?.round, startTurn: game.combat?.turn },
      changes: [{ key: "system.attributes.movement.walk", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "-15", priority: 20 }]
    }]);

    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<strong>Brutal Strike — Hamstring Blow!</strong><br>
                ${target.name}'s Speed wurde um 15ft reduziert bis zum Start deines nächsten Zuges.`
    });
  }

  // Brutal Strike Effekt nach DamageRollComplete disablen
  Hooks.once("midi-qol.DamageRollComplete", async (wf) => {
    if (wf.id !== workflow.id) return;
    const brutalEffect = findItemEffect(actor, "Reckless Attack: Brutal Strike Damage");
    if (brutalEffect) await brutalEffect.update({ disabled: true });
    state.brutalChoice = null;
    console.log(`${MODULE_ID} | DamageRollComplete | Brutal Effect disabled`);
  });
}

// ============================================================
// Hook: combatTurnChange — State zurücksetzen
// ============================================================

async function onCombatTurnChange(combat) {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.name !== ACTOR_NAME) continue;
    console.log(`${MODULE_ID} | combatTurnChange | State zurücksetzen`);
    state.newTurn();
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
    if (!flagData) { ui.notifications.warn("Keine Zieldaten gefunden!"); return; }
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

  Hooks.on("midi-qol.preItemRoll",        onPreItemRoll);
  Hooks.on("midi-qol.preAttackRoll",      onPreAttackRoll);
  Hooks.on("midi-qol.preAttackRollConfig", onPreAttackRollConfig);
  Hooks.on("midi-qol.AttackRollComplete", onAttackRollComplete);
  Hooks.on("midi-qol.preDamageRoll",      onPreDamageRoll);
  Hooks.on("combatTurnChange",            onCombatTurnChange);
  Hooks.on("renderChatMessageHTML",       onRenderChatMessageHTML);

  console.log(`${MODULE_ID} | Alle Hooks registriert`);
});