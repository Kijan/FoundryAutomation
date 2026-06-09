// ============================================================
// Nisras Barbarian Automation v1.3
// ============================================================

const MODULE_ID = "nisras-automation";
const ACTOR_NAME = "Nisras";

// ============================================================
// Zustands-Variablen (im Modul-Scope, kein Server-Roundtrip)
// ============================================================

const state = {
  // Welcher Workflow läuft gerade
  currentWorkflowId: null,
  // Wurde preItemRoll bereits verarbeitet für diesen Workflow?
  preItemRollDone: false,
  // Wurde preDamageRoll bereits verarbeitet für diesen Workflow?
  preDamageDone: false,
  // Reckless gerade aktiviert?
  recklessActivated: false,
  // Brutal Strike Wahl
  brutalChoice: null,
  // Frenzy noch ausstehend?
  frenzyPending: false,
  // Erster Angriff dieser Runde?
  firstAttackDone: false,
  // Combat Round/Turn beim letzten Angriff
  lastAttackRound: null,
  lastAttackTurn: null,

  reset() {
    this.currentWorkflowId = null;
    this.preItemRollDone = false;
    this.preDamageDone = false;
    this.recklessActivated = false;
    this.brutalChoice = null;
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
  if (state.preItemRollDone && state.currentWorkflowId === workflowId) return;

  state.currentWorkflowId = workflowId;
  state.preItemRollDone = true;
  state.preDamageDone = false;
  state.recklessActivated = false;
  state.brutalChoice = null;

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

  // 2. Reckless Attack
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

  // Frenzy-Flag
  if (firstAttack && recklessNow) {
    state.frenzyPending = true;
  }

  // 3. Brutal Strike
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
      if (brutalEffect) await brutalEffect.update({ disabled: false });
    }
  }

  state.markAttack();
}

// ============================================================
// Hook: midi-qol.preAttackRoll — Advantage/Suppress in Tracker
// ============================================================

async function onPreAttackRoll(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;

  if (state.brutalChoice !== null) {
    // Brutal Strike: kein Advantage
    workflow.attackRollModifierTracker.reset();
  } else if (hasEffect(actor, "Attacking Recklessly") || state.recklessActivated) {
    // Reckless ohne Brutal Strike: Advantage
    workflow.attackRollModifierTracker.advantage.add("reckless", "Reckless Attack");
  }
}

// ============================================================
// Hook: midi-qol.AttackRollComplete — Brutal Effect bei Miss disablen
// ============================================================

async function onAttackRollComplete(workflow) {
  const actor = workflow.actor;
  if (actor.name !== ACTOR_NAME) return;
  if (workflow.activity?.actionType !== "mwak") return;

  // Bei Miss: Brutal Strike Effekt sofort disablen
  if (!workflow.hitTargets?.size && state.brutalChoice !== null) {
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

  // Guard: nur einmal pro Workflow
  if (state.preDamageDone && state.currentWorkflowId === workflow.id) return;

  // Nur für den Haupt-Workflow (nicht für Frenzy/Brutal Sub-Workflows)
  // Frenzy und Brutal haben andere workflow IDs
  const isMainWorkflow = workflow.item?.name === "Großvaters Axt" ||
    workflow.activity?.actionType === "mwak";
  if (!isMainWorkflow) return;

  state.preDamageDone = true;

  const recklessActive = hasEffect(actor, "Attacking Recklessly");

  // 1. Frenzy beim ersten Treffer
  if (recklessActive && state.frenzyPending) {
    const activity = actor.items.getName("Frenzy")?.system.activities?.contents[0];
    if (activity) {
      await activity.use({}, { configure: false }, { create: true });
    }
    state.frenzyPending = false;
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
  });
}

// ============================================================
// Hook: combatTurnChange — State zurücksetzen
// ============================================================

async function onCombatTurnChange(combat) {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || actor.name !== ACTOR_NAME) continue;
    state.reset();
    state.frenzyPending = false;
    state.lastAttackRound = null;
    state.lastAttackTurn = null;
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
  Hooks.on("midi-qol.AttackRollComplete", onAttackRollComplete);
  Hooks.on("midi-qol.preDamageRoll",      onPreDamageRoll);
  Hooks.on("combatTurnChange",            onCombatTurnChange);
  Hooks.on("renderChatMessageHTML",       onRenderChatMessageHTML);

  console.log(`${MODULE_ID} | Alle Hooks registriert`);
});