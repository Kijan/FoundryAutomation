// ============================================================
// Nisras Barbarian Automation v2.0
// ============================================================
// Automatisiert für den Barbaren "Nisras":
//   - Rage Erinnerung/Aktivierung
//   - Reckless Attack Abfrage/Aktivierung
//   - Brutal Strike (inkl. Advantage-Verzicht via noAdvantage Flag)
//   - Frenzy beim ersten Treffer
//   - Forceful Blow (GM-Button zum Wegschieben)
//   - Hamstring Blow (Speed -15ft Effekt)
// ============================================================

const MODULE_ID = "nisras-automation";
const ACTOR_NAME = "Nisras";

// Namen der relevanten Items/Effekte (zentral, falls sie sich ändern)
const NAMES = {
  rage: "Rage",
  reckless: "Reckless Attack",
  recklessEffect: "Attacking Recklessly",
  frenzy: "Frenzy",
  brutalEffect: "Reckless Attack: Brutal Strike Damage"
};

// ============================================================
// Zustand (Modul-Scope, pro Client)
// ============================================================

const state = {
  // Pro Angriff
  workflowId: null,        // ID des aktuell verarbeiteten Workflows
  brutalChoice: null,      // null | "forceful" | "hamstring" | "none"

  // Pro Zug
  frenzyPending: false,    // Frenzy noch auszulösen diese Runde?
  lastAttackRound: null,
  lastAttackTurn: null,

  resetTurn() {
    this.workflowId = null;
    this.brutalChoice = null;
    this.frenzyPending = false;
    this.lastAttackRound = null;
    this.lastAttackTurn = null;
  },

  isFirstAttackThisTurn() {
    return this.lastAttackRound !== (game.combat?.round ?? null)
        || this.lastAttackTurn  !== (game.combat?.turn  ?? null);
  },

  markAttackThisTurn() {
    this.lastAttackRound = game.combat?.round ?? null;
    this.lastAttackTurn  = game.combat?.turn  ?? null;
  }
};

// ============================================================
// Hilfsfunktionen
// ============================================================

function isNisras(actor) {
  return actor?.name === ACTOR_NAME;
}

function hasEffect(actor, name) {
  return actor.effects.some(e => e.name === name && !e.disabled);
}

function getRageUses(actor) {
  return actor.items.getName(NAMES.rage)?.system.uses?.value ?? 0;
}

function findItemEffect(actor, name) {
  return actor.items.contents
    .flatMap(i => i.effects.contents)
    .find(e => e.name === name);
}

async function useFeature(actor, featureName) {
  const activity = actor.items.getName(featureName)?.system.activities?.contents[0];
  if (!activity) return false;
  await activity.use({}, { configure: false }, { create: true });
  return true;
}

// Conditions die Disadvantage auf Angriffe geben (aus AC5E, dynamisch)
function hasAttackDisadvantageCondition(actor) {
  if (typeof ac5e === "undefined") return false;
  return Object.entries(ac5e.statusEffectsTables)
    .filter(([_, v]) => "attack" in (v.rules ?? {}))
    .some(([id]) => actor.statuses.has(id));
}

// Erzwingt NORMAL-Wurf im dnd5e.preRollAttack Hook.
// Notwendig weil AC5E die Advantage-Attribution direkt aus dem Midi-Tracker liest
// und ein simples suppress() die Attribution nicht entfernt.
function forceNormalAttackRoll(config, dialog) {
  const ADV = CONFIG.Dice.D20Roll.ADV_MODE;
  const wf = config.workflow;

  // 1. Midi-Tracker Advantage komplett entfernen (active + Attribution)
  const tracker = wf?.attackRollModifierTracker;
  if (tracker) {
    tracker.advantage.clear();
    if (tracker.attribution?.ADV) delete tracker.attribution.ADV;
  }

  // 2. AC5E roll-config bereinigen
  const r0 = config.rolls?.[0]?.options;
  if (r0) {
    r0.advantage = false;
    r0.advantageMode = ADV.NORMAL;
    r0.defaultButton = "normal";
    const ac5e = r0["automated-conditions-5e"];
    if (ac5e) {
      ac5e.advantageMode = ADV.NORMAL;
      ac5e.defaultButton = "normal";
      ac5e.proposedButton = "normal";
      ac5e.calculatedDefaultButton = "normal";
      ac5e.hasTransitAdvantage = false;
      if (ac5e.subject) { ac5e.subject.advantage = []; ac5e.subject.midiAdvantage = []; }
      if (ac5e.transientRollState) {
        ac5e.transientRollState.advantageMode = ADV.NORMAL;
        ac5e.transientRollState.defaultButton = "normal";
        ac5e.transientRollState.hasTransitAdvantage = false;
      }
    }
  }

  // 3. Dialog-Vorauswahl
  if (dialog?.options) {
    dialog.options.advantageMode = ADV.NORMAL;
    dialog.options.defaultButton = "normal";
  }

  config.advantage = false;
}

// ============================================================
// Dialoge
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

function askBrutalStrikeEffect() {
  return new Promise(resolve => {
    new Dialog({
      title: "Brutal Strike — Zusatzeffekt",
      content: `<p>Welchen Brutal Strike Zusatzeffekt möchtest du nutzen?</p>`,
      buttons: {
        forceful:  { label: "Forceful Blow",  callback: () => resolve("forceful") },
        hamstring: { label: "Hamstring Blow", callback: () => resolve("hamstring") },
        none:      { label: "Keinen",         callback: () => resolve("none") }
      },
      default: "none",
      close: () => resolve("none")
    }).render(true);
  });
}

// ============================================================
// Schritt 1: preItemRoll — alle Abfragen VOR der Chat-Karte
// ============================================================

async function onPreItemRoll(data) {
  const { activity, token } = data;
  const actor = token?.actor;
  if (!isNisras(actor)) return;
  if (activity?.actionType !== "mwak") return;

  // Workflow-ID stabil bestimmen (in preItemRoll ist workflow.id noch instabil,
  // daher nutzen wir die activity uuid + Zeitstempel als Abgrenzung pro Angriff)
  const firstAttack = state.isFirstAttackThisTurn();

  // --- 1. Rage ---
  if (!hasEffect(actor, NAMES.recklessEffect) && firstAttack
      && !hasEffect(actor, "Rage") && getRageUses(actor) > 0) {
    const doRage = await askYesNo(
      "Rage aktivieren?",
      "Du hast noch Rage-Ladungen. Rage aktivieren? <em>(Bonus Action)</em>"
    );
    if (doRage) {
      await useFeature(actor, NAMES.rage);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // --- 2. Reckless Attack (nur erster Angriff der Runde) ---
  let recklessActive = hasEffect(actor, NAMES.recklessEffect);
  if (hasEffect(actor, "Rage") && firstAttack && !recklessActive) {
    const doReckless = await askYesNo(
      "Reckless Attack?",
      "Reckless Attack nutzen? Advantage auf Stärke-Angriffe, aber Angriffe gegen dich haben Advantage bis zu deinem nächsten Zug."
    );
    if (doReckless) {
      await useFeature(actor, NAMES.reckless);
      await new Promise(r => setTimeout(r, 400));
      recklessActive = true;
    }
  }

  // --- Frenzy-Flag (erster Angriff + Reckless aktiv) ---
  if (firstAttack && recklessActive) {
    state.frenzyPending = true;
  }

  // --- 3. Brutal Strike (jeder Angriff, wenn Reckless aktiv und kein Disadvantage) ---
  state.brutalChoice = null;
  const brutalEffect = findItemEffect(actor, NAMES.brutalEffect);
  if (brutalEffect && !brutalEffect.disabled) await brutalEffect.update({ disabled: true });

  if (recklessActive && !hasAttackDisadvantageCondition(actor)) {
    const doBrutal = await askYesNo(
      "Brutal Strike?",
      "Brutal Strike nutzen? Du verzichtest auf Advantage bei diesem Angriff für zusätzlichen Schaden und einen Effekt."
    );
    if (doBrutal) {
      state.brutalChoice = await askBrutalStrikeEffect();
      // Advantage-Unterdrückung passiert im dnd5e.preRollAttack Hook (forceNormalAttackRoll)
      // 1d10 Bonus-Schaden Effekt aktivieren
      if (brutalEffect) await brutalEffect.update({ disabled: false });
    }
  }

  state.markAttackThisTurn();
}

// ============================================================
// Schritt 2: AttackRollComplete — Aufräumen bei Miss
// ============================================================

async function onAttackRollComplete(workflow) {
  const actor = workflow.actor;
  if (!isNisras(actor)) return;
  if (workflow.activity?.actionType !== "mwak") return;

  // Bei Miss: Brutal Strike Effekt deaktivieren und Wahl verwerfen
  if (!workflow.hitTargets?.size && state.brutalChoice !== null) {
    const brutalEffect = findItemEffect(actor, NAMES.brutalEffect);
    if (brutalEffect && !brutalEffect.disabled) await brutalEffect.update({ disabled: true });
    state.brutalChoice = null;
  }
}

// ============================================================
// Schritt 3: preDamageRoll — Frenzy + Brutal Strike Effekte
// ============================================================

async function onPreDamageRoll(workflow) {
  const actor = workflow.actor;
  if (!isNisras(actor)) return;
  if (workflow.activity?.actionType !== "mwak") return;
  if (!workflow.hitTargets?.size) return;

  // Guard: pro Workflow nur einmal
  if (state.workflowId === workflow.id) return;
  state.workflowId = workflow.id;

  // --- Frenzy beim ersten Treffer dieser Runde ---
  if (hasEffect(actor, NAMES.recklessEffect) && state.frenzyPending) {
    await useFeature(actor, NAMES.frenzy);
    state.frenzyPending = false;
  }

  // --- Brutal Strike Zusatzeffekte ---
  if (!state.brutalChoice || state.brutalChoice === "none") {
    scheduleBrutalCleanup(actor, workflow.id);
    return;
  }

  const target = workflow.hitTargets.first();
  if (!target) { scheduleBrutalCleanup(actor, workflow.id); return; }

  if (state.brutalChoice === "forceful") {
    await applyForcefulBlow(actor, workflow.token, target);
  } else if (state.brutalChoice === "hamstring") {
    await applyHamstringBlow(actor, target);
  }

  scheduleBrutalCleanup(actor, workflow.id);
}

// Brutal Effekt nach dem Damage-Roll wieder deaktivieren
function scheduleBrutalCleanup(actor, workflowId) {
  Hooks.once("midi-qol.DamageRollComplete", async (wf) => {
    if (wf.id !== workflowId) return;
    const brutalEffect = findItemEffect(actor, NAMES.brutalEffect);
    if (brutalEffect && !brutalEffect.disabled) await brutalEffect.update({ disabled: true });
    state.brutalChoice = null;
  });
}

// ============================================================
// Brutal Strike Effekt-Anwendungen
// ============================================================

async function applyForcefulBlow(actor, attackerToken, targetToken) {
  const gridSize = canvas.grid.size;
  const pushPx   = gridSize * 3; // 15ft = 3 Felder

  const ax = attackerToken.x + attackerToken.w / 2;
  const ay = attackerToken.y + attackerToken.h / 2;
  const tx = targetToken.x + targetToken.w / 2;
  const ty = targetToken.y + targetToken.h / 2;
  const dx = tx - ax;
  const dy = ty - ay;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  const newX = targetToken.x + (dx / len) * pushPx;
  const newY = targetToken.y + (dy / len) * pushPx;

  await actor.setFlag("world", "barbarianForcefulBlowTarget", {
    tokenUuid: targetToken.document.uuid,
    x: newX,
    y: newY
  });

  const halfSpeed = Math.floor((actor.system.attributes.movement.walk ?? 30) / 2);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <strong>Brutal Strike — Forceful Blow!</strong><br>
      ${targetToken.name} soll 15ft weggestoßen werden.<br>
      Du kannst dich bis zu ${halfSpeed}ft auf das Ziel zu bewegen ohne Opportunity Attacks.<br>
      <button class="nisras-forceful-blow-confirm" data-actor-uuid="${actor.uuid}"
              style="margin-top:6px; width:100%; cursor:pointer;">
        ✅ Push bestätigen (GM)
      </button>
    `
  });
}

async function applyHamstringBlow(actor, targetToken) {
  const existing = targetToken.actor.effects.find(e => e.name === "Hamstring Blow");
  if (existing) await existing.delete();

  await targetToken.actor.createEmbeddedDocuments("ActiveEffect", [{
    name: "Hamstring Blow",
    icon: "icons/skills/wounds/injury-knee-polearm-heavy.webp",
    origin: actor.uuid,
    duration: { rounds: 1, startRound: game.combat?.round, startTurn: game.combat?.turn },
    changes: [{
      key: "system.attributes.movement.walk",
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: "-15",
      priority: 20
    }]
  }]);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<strong>Brutal Strike — Hamstring Blow!</strong><br>
              ${targetToken.name}'s Speed wurde um 15ft reduziert bis zum Start deines nächsten Zuges.`
  });
}

// ============================================================
// combatTurnChange — Zustand pro Zug zurücksetzen
// ============================================================

async function onCombatTurnChange(combat) {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!isNisras(actor)) continue;
    state.resetTurn();
    await actor.unsetFlag("world", "barbarianForcefulBlowTarget").catch(() => {});
  }
}

// ============================================================
// renderChatMessageHTML — Forceful Blow GM-Button
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
// Initialisierung
// ============================================================

// dnd5e.preRollAttack — erzwingt NORMAL wenn Brutal Strike gewählt wurde
function onDnd5ePreRollAttack(config, dialog, message) {
  const actor = config.workflow?.actor ?? config.subject?.actor;
  if (!isNisras(actor)) return;
  if (state.brutalChoice === null) return;
  forceNormalAttackRoll(config, dialog);
}

Hooks.once("ready", () => {
  Hooks.on("midi-qol.preItemRoll",        onPreItemRoll);
  Hooks.on("dnd5e.preRollAttack",         onDnd5ePreRollAttack);
  Hooks.on("midi-qol.AttackRollComplete", onAttackRollComplete);
  Hooks.on("midi-qol.preDamageRoll",      onPreDamageRoll);
  Hooks.on("combatTurnChange",            onCombatTurnChange);
  Hooks.on("renderChatMessageHTML",       onRenderChatMessageHTML);

  console.log(`${MODULE_ID} | v2.1 geladen und Hooks registriert`);
});