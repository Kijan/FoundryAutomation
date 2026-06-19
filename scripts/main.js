// ============================================================
// FoundryAutomation — Nisras Barbarian
// ============================================================
// Schlanke Version: Die Mechanik (Schaden, noAdvantage, Ablaufen)
// liegt in Active Effects + DAE Special Durations. Das Modul ist
// nur noch der "Dirigent": Dialoge zeigen, Features ausloesen,
// den Brutal-Strike-Effekt aktivieren, Forceful/Hamstring anwenden.
//
// Voraussetzungen (ausserhalb des Moduls konfiguriert):
//   - Feature "Reckless Attack": loest beim Aktivieren auch Frenzy aus
//     und hat Use-Condition: effects.some(e => e.name === "Rage")
//   - Effekt "Reckless Attack: Brutal Strike Damage" auf einem Item,
//     deaktiviert. Enthaelt: Bonus-Schaden, noAdvantage-Flag,
//     Special Duration "1 Attack". Das Modul aktiviert ihn nur.
// ============================================================

const MODULE_ID = "nisras-automation";
const ACTOR_NAME = "Nisras";

const NAMES = {
  rage: "Rage",
  reckless: "Reckless Attack",
  recklessEffect: "Attacking Recklessly",
  brutalEffect: "Reckless Attack: Brutal Strike Damage"
};

// ============================================================
// Zustand
// ============================================================

const state = {
  brutalChoice: null,      // null | "forceful" | "hamstring" | "none"
  lastAttackRound: null,
  lastAttackTurn: null,

  resetTurn() {
    this.brutalChoice = null;
    this.lastAttackRound = null;
    this.lastAttackTurn = null;
  },

  isFirstAttackThisTurn() {
    if (!game.combat) return true;
    return this.lastAttackRound !== game.combat.round
        || this.lastAttackTurn  !== game.combat.turn;
  },

  markAttackThisTurn() {
    if (!game.combat) return;
    this.lastAttackRound = game.combat.round;
    this.lastAttackTurn  = game.combat.turn;
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

function findEffect(actor, name) {
  const onActor = actor.effects.find(e => e.name === name);
  if (onActor) return onActor;
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

function hasAttackDisadvantageCondition(actor) {
  if (typeof ac5e === "undefined") return false;
  return Object.entries(ac5e.statusEffectsTables)
    .filter(([_, v]) => "attack" in (v.rules ?? {}))
    .some(([id]) => actor.statuses.has(id));
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
// preItemRoll — Dialoge vor der Chat-Karte
// ============================================================

async function onPreItemRoll(data) {
  const { activity, token } = data;
  const actor = token?.actor;
  if (!isNisras(actor)) return;
  if (activity?.actionType !== "mwak") return;

  const firstAttack = state.isFirstAttackThisTurn();

  // 1. Rage-Erinnerung (erster Angriff, Rage nicht aktiv, Ladungen vorhanden)
  if (!hasEffect(actor, NAMES.rage) && firstAttack && getRageUses(actor) > 0) {
    const doRage = await askYesNo(
      "Rage aktivieren?",
      "Du hast noch Rage-Ladungen. Rage aktivieren? <em>(Bonus Action)</em>"
    );
    if (doRage) {
      await useFeature(actor, NAMES.rage);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // 2. Reckless Attack (erster Angriff, Rage aktiv, noch nicht reckless)
  //    Loest ueber das Feature automatisch auch Frenzy aus.
  if (hasEffect(actor, NAMES.rage) && firstAttack && !hasEffect(actor, NAMES.recklessEffect)) {
    const doReckless = await askYesNo(
      "Reckless Attack?",
      "Reckless Attack nutzen? Advantage auf Stärke-Angriffe, aber Angriffe gegen dich haben Advantage bis zu deinem nächsten Zug."
    );
    if (doReckless) {
      await useFeature(actor, NAMES.reckless);
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // 3. Brutal Strike (jeder Angriff, wenn reckless aktiv und kein Disadvantage)
  //    Der Effekt bringt Schaden + noAdvantage + Ablaufen (1 Attack) selbst mit.
  state.brutalChoice = null;
  if (hasEffect(actor, NAMES.recklessEffect) && !hasAttackDisadvantageCondition(actor)) {
    const doBrutal = await askYesNo(
      "Brutal Strike?",
      "Brutal Strike nutzen? Du verzichtest auf Advantage bei diesem Angriff für zusätzlichen Schaden und einen Effekt."
    );
    if (doBrutal) {
      state.brutalChoice = await askBrutalStrikeEffect();
      const brutalEffect = findEffect(actor, NAMES.brutalEffect);
      if (brutalEffect && brutalEffect.disabled) await brutalEffect.update({ disabled: false });
    }
  }

  state.markAttackThisTurn();
}

// ============================================================
// DamageRollComplete — Forceful / Hamstring NACH dem Damage-Roll
// ============================================================

async function onDamageRollComplete(workflow) {
  const actor = workflow.actor;
  if (!isNisras(actor)) return;
  if (workflow.activity?.actionType !== "mwak") return;
  if (!workflow.hitTargets?.size) return;

  if (!state.brutalChoice || state.brutalChoice === "none") return;

  const target = workflow.hitTargets.first();
  if (!target) return;

  if (state.brutalChoice === "forceful") {
    await applyForcefulBlow(actor, workflow.token, target);
  } else if (state.brutalChoice === "hamstring") {
    await applyHamstringBlow(actor, target);
  }
  // brutalChoice wird beim naechsten Angriff / Rundenwechsel zurueckgesetzt
}

// ============================================================
// Brutal Strike Zusatzeffekte
// ============================================================

async function applyForcefulBlow(actor, attackerToken, targetToken) {
  const gridSize = canvas.grid.size;
  const pushPx   = gridSize * 3; // 15ft

  const ax = attackerToken.x + attackerToken.w / 2;
  const ay = attackerToken.y + attackerToken.h / 2;
  const tx = targetToken.x + targetToken.w / 2;
  const ty = targetToken.y + targetToken.h / 2;
  const dx = tx - ax;
  const dy = ty - ay;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  const rawX = targetToken.x + (dx / len) * pushPx;
  const rawY = targetToken.y + (dy / len) * pushPx;

  // An das Grid snappen (Center-basiert)
  const half = (canvas.grid.size * (targetToken.document.width ?? 1)) / 2;
  const snappedCenter = canvas.grid.getSnappedPoint(
    { x: rawX + half, y: rawY + half },
    { mode: CONST.GRID_SNAPPING_MODES.CENTER }
  );
  const newX = snappedCenter.x - half;
  const newY = snappedCenter.y - half;

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
// combatTurnChange — Zustand zurücksetzen
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

Hooks.once("ready", () => {
  Hooks.on("midi-qol.preItemRoll",      onPreItemRoll);
  Hooks.on("midi-qol.DamageRollComplete", onDamageRollComplete);
  Hooks.on("combatTurnChange",          onCombatTurnChange);
  Hooks.on("renderChatMessageHTML",     onRenderChatMessageHTML);

  console.log(`${MODULE_ID} | v3.0 (schlank) geladen und Hooks registriert`);
});