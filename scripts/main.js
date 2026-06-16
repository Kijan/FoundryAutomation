// =========================================================================
// NISRAS COMBAT HELPER: MODUL-LADEMELDUNG
// =========================================================================
console.warn("%c=======================================================", "color: yellow; font-weight: bold; font-size: 14px;");
console.warn("%c[Nisras Combat Helper] SKRIPT ERFOLGREICH GELADEN!", "color: yellow; font-weight: bold; font-size: 14px;");
console.warn("%cDer Angriffs-Workflow wird nun bei 'preAttackRoll' pausiert.", "color: lightgreen; font-size: 12px;");
console.warn("%c=======================================================", "color: yellow; font-weight: bold; font-size: 14px;");

// Interner Status zur Nachverfolgung der Ressourcen und Aktionen pro Runde
const state = {
  attacksThisRound: 0,
  hitsThisRound: 0,
  brutalStrikeUsedThisAttack: false,
  brutalStrikeEffectChosen: null, // "forceful", "hamstring" oder null
};

// Zurücksetzen des Status beim Rundenwechsel (bevorzugt am Start von Nisras' Zug)
Hooks.on("updateCombat", (combat, update, options, userId) => {
  if (update.round !== undefined || update.turn !== undefined) {
    const activeCombatant = combat.combatant;
    const activeActor = activeCombatant?.actor;
    if (activeActor && activeActor.name.trim().toLowerCase() === "nisras") {
      state.attacksThisRound = 0;
      state.hitsThisRound = 0;
      state.brutalStrikeUsedThisAttack = false;
      state.brutalStrikeEffectChosen = null;
      console.log("[Nisras Combat Helper] Status für neue Runde zurückgesetzt.");
    }
  }
});

// Zurücksetzen bei Kampfende
Hooks.on("deleteCombat", () => {
  state.attacksThisRound = 0;
  state.hitsThisRound = 0;
  state.brutalStrikeUsedThisAttack = false;
  state.brutalStrikeEffectChosen = null;
  console.log("[Nisras Combat Helper] Status nach Kampfende zurückgesetzt.");
});

// Hilfsfunktion: Sucht nach dem Schadenseffekt (entweder direkt auf dem Actor oder auf einem Item)
function findBrutalStrikeEffect(actor) {
  let effect = actor.effects.find(e => (e.name || e.label) === "Reckless Attack: Brutal Strike Damage");
  if (effect) return effect;

  for (let item of actor.items) {
    effect = item.effects.find(e => (e.name || e.label) === "Reckless Attack: Brutal Strike Damage");
    if (effect) return effect;
  }
  return null;
}

// =========================================================================
// ASYNCHRONER HOOK: Pausiert den Wurf, bevor Midi-QOL die Würfel triggert
// =========================================================================
Hooks.on("midi-qol.preAttackRoll", async (...args) => {
  // Kompatibilitäts-Weiche für verschiedene Midi-QOL Signaturen: (item, workflow) oder (workflow)
  let workflow = args.length === 2 ? args[1] : args[0];
  if (!workflow) return;

  const actor = workflow.actor;
  if (!actor) return;

  // Namensprüfung (Fehlertolerant)
  const actorNameNormalized = actor.name.trim().toLowerCase();
  if (actorNameNormalized !== "nisras") return;

  const item = workflow.item;
  const activity = workflow.activity;

  // Typ und Attribut ermitteln (mwak und Stärke)
  const actionType = activity?.actionType || item?.system?.actionType;
  const rawAbility = activity?.attack?.ability || activity?.ability || item?.abilityMod || item?.system?.ability;

  const isFinesse = item?.system?.properties?.has?.("fin") || false;
  const isStrengthAttack = (rawAbility === "str") || (!rawAbility && !isFinesse);

  if (actionType !== "mwak" || !isStrengthAttack) {
    console.log(`[Nisras Combat Helper] Ignoriere Angriff: Kein Nahkampf-Stärkeangriff.`);
    return;
  }

  console.log(`[Nisras Combat Helper] Nahkampf-Stärkeangriff erkannt. Workflow wird pausiert...`);
  const currentAttacks = game.combat ? state.attacksThisRound : 0;

  // 1. RAGE CHECK
  const isRaging = actor.effects.some(e => !e.disabled && ((e.name || e.label) === "Rage"));
  const rageItem = actor.items.find(i => i.name === "Rage");
  const hasRageCharges = rageItem ? (rageItem.system.uses?.value > 0) : false;

  if (!isRaging && hasRageCharges && currentAttacks === 0) {
    const useRage = await Dialog.confirm({
      title: "Rage aktivieren?",
      content: "<p>Möchtest du Zorn (Rage) aktivieren? (Kostet Bonus Action)</p>",
      yes: () => true,
      no: () => false,
      defaultYes: true
    });

    if (useRage && rageItem) {
      console.log("[Nisras Combat Helper] Aktiviere Rage...");
      await MidiQOL.completeItemUse(rageItem);
      await new Promise(r => setTimeout(r, 500)); // Datenbank-Synchronisierung abwarten
    }
  }

  // 2. RECKLESS ATTACK CHECK
  const updatedRaging = actor.effects.some(e => !e.disabled && ((e.name || e.label) === "Rage"));
  const isReckless = actor.effects.some(e => !e.disabled && ((e.name || e.label) === "Attacking Recklessly"));
  const recklessItem = actor.items.find(i => i.name === "Reckless Attack");

  if (updatedRaging && currentAttacks === 0 && !isReckless && recklessItem) {
    const useReckless = await Dialog.confirm({
      title: "Reckless Attack nutzen?",
      content: "<p>Möchtest du rücksichtslos angreifen? (Vorteil auf deine Angriffe, Gegner im Gegenzug im Vorteil gegen dich)</p>",
      yes: () => true,
      no: () => false,
      defaultYes: true
    });

    if (useReckless) {
      console.log("[Nisras Combat Helper] Aktiviere Reckless...");
      await MidiQOL.completeItemUse(recklessItem);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 3. BRUTAL STRIKE CHECK
  const finalReckless = actor.effects.some(e => !e.disabled && ((e.name || e.label) === "Attacking Recklessly"));
  const tracker = workflow.attackRollModifierTracker || workflow.tracker;
  const hasDisadvantage = tracker ? tracker.hasDisadvantage : false;

  if (finalReckless && !hasDisadvantage) {
    const useBrutal = await Dialog.confirm({
      title: "Brutal Strike nutzen?",
      content: "<p>Möchtest du Brutal Strike anwenden? (Gibt Vorteil für diesen Angriff auf, verursacht +1d10 Schaden und Zusatzeffekt bei Treffer)</p>",
      yes: () => true,
      no: () => false,
      defaultYes: false
    });

    if (useBrutal) {
      console.log("[Nisras Combat Helper] Brutal Strike gewählt. Erzeuge Unterdrückungs-Effekt...");

      // Erzeuge temporären DAE-Effekt, um Vorteil für diesen einen Angriff zu unterdrücken
      const tempEffectData = {
        name: "Brutal Strike Suppression",
        img: "icons/skills/melee/strike-blade-slashing-blue.webp",
        changes: [
          {
            key: "flags.midi-qol.noAdvantage.attack.mwak",
            mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
            value: "1",
            priority: 100
          }
        ],
        flags: {
          dae: {
            specialDuration: ["1Attack"] // Löscht sich nach dem aktuellen Angriff vollautomatisch selbst!
          }
        }
      };
      await actor.createEmbeddedDocuments("ActiveEffect", [tempEffectData]);

      // Effektauswahl
      const effectChosen = await new Promise((resolve) => {
        new Dialog({
          title: "Zusatzeffekt wählen",
          content: "<p>Wähle deinen Brutal Strike Effekt:</p>",
          buttons: {
            forceful: { label: "Forceful Blow (15ft Push)", callback: () => resolve("forceful") },
            hamstring: { label: "Hamstring Blow (-15ft Speed)", callback: () => resolve("hamstring") },
            none: { label: "Keiner", callback: () => resolve(null) }
          },
          default: "forceful",
          close: () => resolve(null)
        }).render(true);
      });

      state.brutalStrikeUsedThisAttack = true;
      state.brutalStrikeEffectChosen = effectChosen;

      // Schadenseffekt aktivieren
      const bsDamageEffect = findBrutalStrikeEffect(actor);
      if (bsDamageEffect) {
        await bsDamageEffect.update({ disabled: false });
        console.log("[Nisras Combat Helper] Brutal Strike Damage-Effekt (+1d10) aktiviert.");
      } else {
        ui.notifications.warn("Effekt 'Reckless Attack: Brutal Strike Damage' wurde auf Nisras nicht gefunden.");
      }
    }
  }

  if (game.combat) {
    state.attacksThisRound++;
  }
});

// =========================================================================
// LOGIK NACH DEM WURF: On-Hit Effekte und Aufräumen
// =========================================================================
Hooks.on("midi-qol.RollComplete", async (workflow) => {
  const actor = workflow.actor;
  if (!actor || actor.name.trim().toLowerCase() !== "nisras") return;

  // Cleanup: Schadenseffekt (+1d10) nach dem Wurf sofort wieder deaktivieren
  const bsDamageEffect = findBrutalStrikeEffect(actor);
  if (bsDamageEffect && !bsDamageEffect.disabled) {
    await bsDamageEffect.update({ disabled: true });
    console.log("[Nisras Combat Helper] Brutal Strike Damage-Effekt (+1d10) wieder deaktiviert.");
  }

  const hit = workflow.hitTargets.size > 0;

  // Brutal Strike Effekte bei Treffer auslösen
  if (state.brutalStrikeUsedThisAttack && hit) {
    const attackerToken = workflow.token;

    for (let targetToken of workflow.hitTargets) {
      if (state.brutalStrikeEffectChosen === "forceful") {
        // Chat-Button für den GM generieren
        const content = `
          <div class="nisras-push-card" style="border: 1px solid #7a7975; padding: 8px; border-radius: 5px; background: rgba(0,0,0,0.1);">
            <p><strong>Brutal Strike: Forceful Blow!</strong></p>
            <p>Nisras möchte <strong>${targetToken.name}</strong> 15 Fuß wegschieben.</p>
            <button class="nisras-push-btn" 
                    style="width: 100%; cursor: pointer; background: #555; color: #fff; border: 1px solid #111; padding: 4px; border-radius: 3px;"
                    data-target-token-id="${targetToken.id}" 
                    data-attacker-token-id="${attackerToken.id}">
              Bewegung bestätigen (Nur GM)
            </button>
          </div>
        `;
        await ChatMessage.create({
          user: game.user.id,
          content: content,
          speaker: ChatMessage.getSpeaker({ actor: actor })
        });
      } else if (state.brutalStrikeEffectChosen === "hamstring") {
        // Speed-Reduzierung um 15ft via Active Effect auf das Ziel
        const effectData = {
          name: "Hamstring Blow",
          img: "icons/svg/falling.svg",
          changes: [
            {
              key: "system.attributes.movement.walk",
              mode: CONST.ACTIVE_EFFECT_MODES.ADD,
              value: "-15",
              priority: 20
            }
          ],
          duration: { turns: 1 },
          flags: {
            dae: {
              specialDuration: ["turnStartSource"] // Erlischt zu Beginn von Nisras' nächstem Zug
            }
          },
          origin: actor.uuid
        };
        await targetToken.actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
        ui.notifications.info(`Hamstring Blow auf ${targetToken.name} angewendet (-15 Fuß Bewegung).`);
      }
    }
  }

  // FRENZY CHECK (Berserker 2024): Beim ersten Treffer der Runde, wenn rücksichtslos angegriffen wurde
  const isReckless = actor.effects.some(e => !e.disabled && ((e.name || e.label) === "Attacking Recklessly"));
  const currentHits = game.combat ? state.hitsThisRound : 0;

  if (isReckless && hit && currentHits === 0) {
    if (game.combat) state.hitsThisRound++;
    const frenzyItem = actor.items.find(i => i.name === "Frenzy");
    if (frenzyItem) {
      setTimeout(async () => {
        await MidiQOL.completeItemUse(frenzyItem);
      }, 1000);
    }
  }

  // Reset des Angriffsstatus
  state.brutalStrikeUsedThisAttack = false;
  state.brutalStrikeEffectChosen = null;
});

// Listener für den Forceful-Blow Chat-Button (Fremdbewegung benötigt GM-Rechte)
Hooks.on("renderChatMessage", (message, html, data) => {
  const btn = html.find(".nisras-push-btn");
  if (btn.length > 0) {
    btn.on("click", async (event) => {
      event.preventDefault();
      if (!game.user.isGM) {
        ui.notifications.warn("Nur der Spielleiter darf diese Bewegung ausführen.");
        return;
      }

      const targetTokenId = btn.data("target-token-id");
      const attackerTokenId = btn.data("attacker-token-id");

      const targetToken = canvas.tokens.get(targetTokenId);
      const attackerToken = canvas.tokens.get(attackerTokenId);

      if (targetToken && attackerToken) {
        await pushToken(attackerToken, targetToken, 15);
        btn.prop("disabled", true).text("Bewegung ausgeführt");
      }
    });
  }
});

// Vektor-basierte Tokenverschiebung mit Grid-Ausrichtung in Foundry v14
async function pushToken(attacker, target, distanceFeet) {
  const grid = canvas.scene.grid;
  const size = grid.size;
  const distancePx = (distanceFeet / canvas.scene.grid.distance) * size;

  const aCenter = attacker.center;
  const tCenter = target.center;

  const dx = tCenter.x - aCenter.x;
  const dy = tCenter.y - aCenter.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) return;

  const ux = dx / length;
  const uy = dy / length;

  const destX = target.document.x + Math.round(ux * distancePx);
  const destY = target.document.y + Math.round(uy * distancePx);

  const snapped = target.getSnappedPosition({ x: destX, y: destY });

  await target.document.update({ x: snapped.x, y: snapped.y });
  ui.notifications.info(`${target.name} wurde um 15 Fuß weggeschoben.`);
}