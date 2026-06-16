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

// Haupt-Schnittstelle vor der Angriffs-Konfiguration
Hooks.on("midi-qol.preAttackConfig", async (workflow) => {
  const actor = workflow.actor;
  if (!actor) return;

  // 1. SCHRITT: Namensprüfung (Fehlertolerant)
  const actorNameNormalized = actor.name.trim().toLowerCase();
  
  // Debug-Log für jeden Angriffsversuch im Spiel
  console.log(`[Nisras Combat Helper] Hook 'preAttackConfig' gefeuert von Actor: "${actor.name}"`);

  if (actorNameNormalized !== "nisras") {
    console.log(`[Nisras Combat Helper] Hook ignoriert: Name ist nicht "nisras" (Erkannt: "${actorNameNormalized}")`);
    return;
  }

  // 2. SCHRITT: Typ des Angriffs ermitteln (mwak, rwak etc.)
  const actionType = workflow.activity?.actionType 
                  || workflow.item?.system?.actionType 
                  || (workflow.activity?.type === "attack" ? "mwak" : null);

  // 3. SCHRITT: Attribut ermitteln (Stärke, Geschicklichkeit etc.)
  const rawAbility = workflow.activity?.attack?.ability 
                  || workflow.activity?.ability 
                  || workflow.item?.abilityMod 
                  || workflow.item?.system?.ability;

  // Intelligentere Erkennung: Wenn das Attribut leer/default ist, aber die Waffe kein Finesse ("fin") hat, ist es Stärke
  const isFinesse = workflow.item?.system?.properties?.has?.("fin") || false;
  const isStrengthAttack = (rawAbility === "str") || (!rawAbility && !isFinesse);

  console.log(`[Nisras Combat Helper] Prüfe Angriffsdaten:`, {
    item: workflow.item?.name,
    actionType: actionType,
    rawAbility: rawAbility,
    isFinesse: isFinesse,
    isStrengthAttack: isStrengthAttack
  });

  // Filter: Nur Stärke-Nahkampfangriffe zulassen
  if (actionType !== "mwak") {
    console.log(`[Nisras Combat Helper] Abgebrochen: Kein Nahkampf-Waffenangriff (mwak). Typ ist: "${actionType}"`);
    return;
  }

  if (!isStrengthAttack) {
    console.log(`[Nisras Combat Helper] Abgebrochen: Angriff nutzt kein Stärke-Attribut.`);
    return;
  }

  console.log(`[Nisras Combat Helper] Kriterien erfüllt! Starte Abfrage-Workflow...`);

  // Falls außerhalb eines Kampfes getestet wird, ignorieren wir die Runden-Limits für einfacheres Testen
  const currentAttacks = game.combat ? state.attacksThisRound : 0;

  // ==========================================
  // ABLAUF 1: RAGE CHECK
  // ==========================================
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
      console.log("[Nisras Combat Helper] Zünde Rage...");
      await MidiQOL.completeItemUse(rageItem);
      await new Promise(r => setTimeout(r, 500)); // Datenbank-Synchronisierung abwarten
    }
  }

  // ==========================================
  // ABLAUF 2: RECKLESS ATTACK CHECK
  // ==========================================
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
      console.log("[Nisras Combat Helper] Zünde Reckless Attack...");
      await MidiQOL.completeItemUse(recklessItem);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ==========================================
  // ABLAUF 3: BRUTAL STRIKE CHECK
  // ==========================================
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
      console.log("[Nisras Combat Helper] Brutal Strike gewählt. Neutralisiere Vorteil...");
      // Vorteil über Midi-QOL RollModifierTracker aufheben (Angriff wird normal gewürfelt)
      if (tracker) {
        tracker.advantage.suppress("Brutal Strike", "Brutal Strike (Vorteil aufgegeben)");
      }

      // Effektauswahl
      const effectChosen = await new Promise((resolve) => {
        new Dialog({
          title: "Zusatzeffekt wählen",
          content: "<p>Wähle deinen Brutal Strike Effekt:</p>",
          buttons: {
            forceful: {
              label: "Forceful Blow (15ft Push)",
              callback: () => resolve("forceful")
            },
            hamstring: {
              label: "Hamstring Blow (-15ft Speed)",
              callback: () => resolve("hamstring")
            },
            none: {
              label: "Keiner",
              callback: () => resolve(null)
            }
          },
          default: "forceful",
          close: () => resolve(null)
        }).render(true);
      });

      state.brutalStrikeUsedThisAttack = true;
      state.brutalStrikeEffectChosen = effectChosen;

      // Schadenseffekt "+1d10" vor dem Wurf aktivieren
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

// Logik nach Abwicklung des Angriffs und Schadens
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
          duration: {
            turns: 1
          },
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

  // FRENZY CHECK
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