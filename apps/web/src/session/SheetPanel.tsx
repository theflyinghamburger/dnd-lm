import {
  ABILITIES,
  ABILITY_NAMES,
  SKILLS,
  SKILL_IDS,
  SKILL_NAMES,
  type PublicUser,
} from '@dnd-lm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CharacterView, api } from '../api';

const sign = (value: number): string => (value >= 0 ? `+${value}` : `${value}`);

/**
 * Read-only by design (M4.6): every number here is derived server-side and
 * recomputed on read, so there is nothing on this panel to edit except HP.
 */
export function SheetPanel({
  user,
  campaignId,
  characterId,
  onRoll,
}: {
  user: PublicUser;
  campaignId: string;
  characterId: string | null;
  onRoll: (expression: string) => void;
}) {
  const queryClient = useQueryClient();
  const characters = useQuery({
    queryKey: ['characters', campaignId],
    queryFn: () => api.characters(campaignId),
  });

  const character: CharacterView | undefined = characters.data?.find((c) => c.id === characterId);

  const setHp = useMutation({
    mutationFn: (currentHp: number) =>
      api.updateHp(campaignId, character!.id, {
        currentHp,
        expectedStateVersion: character!.stateVersion,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['characters', campaignId] }),
  });

  if (!characterId)
    return (
      <aside>
        <p>No character selected for this session.</p>
      </aside>
    );
  if (!character)
    return (
      <aside>
        <p>Loading sheet…</p>
      </aside>
    );

  const { sheet, derived } = character;
  const mine = character.ownerUserId === user.id;
  // The sheet goes read-only while a mutation for this character is in flight
  // (architecture.md §5.1) — no optimistic HP that a rejection has to undo.
  const busy = setHp.isPending;

  return (
    <aside aria-busy={busy}>
      <h2>
        {character.name}{' '}
        <span className="role">
          {sheet.className} {sheet.level}
        </span>
      </h2>

      <p>
        <strong>AC</strong> {derived.armorClass} · <strong>Initiative</strong>{' '}
        {sign(derived.initiative)} · <strong>Passive Perception</strong> {derived.passivePerception}{' '}
        · <strong>Proficiency</strong> {sign(derived.proficiencyBonus)}
      </p>

      <p>
        <strong>HP</strong> {derived.currentHp} / {derived.maxHp}{' '}
        {mine && (
          <>
            <button
              type="button"
              disabled={busy || derived.currentHp === 0}
              onClick={() => setHp.mutate(Math.max(derived.currentHp - 1, 0))}
            >
              −1
            </button>
            <button
              type="button"
              disabled={busy || derived.currentHp >= derived.maxHp}
              onClick={() => setHp.mutate(Math.min(derived.currentHp + 1, derived.maxHp))}
            >
              +1
            </button>
          </>
        )}
        {busy && <em> saving…</em>}
      </p>

      <h3>Abilities and saves</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">Ability</th>
            <th scope="col">Score</th>
            <th scope="col">Mod</th>
            <th scope="col">Save</th>
          </tr>
        </thead>
        <tbody>
          {ABILITIES.map((ability) => (
            <tr key={ability}>
              <th scope="row">{ABILITY_NAMES[ability]}</th>
              <td>{sheet.abilityScores[ability]}</td>
              <td>{sign(derived.abilityModifiers[ability])}</td>
              <td>
                <button
                  type="button"
                  className="linkish"
                  disabled={!mine}
                  onClick={() => onRoll(`${ability} save`)}
                >
                  {sign(derived.saveModifiers[ability])}
                  {sheet.saveProficiencies.includes(ability) ? ' ●' : ''}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Skills</h3>
      <ul>
        {SKILL_IDS.map((skill) => (
          <li key={skill}>
            <button
              type="button"
              className="linkish"
              disabled={!mine}
              onClick={() => onRoll(skill)}
              // Proficiency is marked with a glyph and stated in the label,
              // never by colour alone (NFR-403).
              aria-label={`Roll ${SKILL_NAMES[skill]}, ${sign(derived.skillModifiers[skill])}${
                sheet.skillProficiencies.includes(skill) ? ', proficient' : ''
              }`}
            >
              {SKILL_NAMES[skill]} {sign(derived.skillModifiers[skill])}
              {sheet.skillProficiencies.includes(skill) ? ' ●' : ''}
            </button>{' '}
            <span className="role">{ABILITY_NAMES[SKILLS[skill]].slice(0, 3)}</span>
          </li>
        ))}
      </ul>

      <h3>Inventory</h3>
      <ul>
        {sheet.inventory.length === 0 && <li>Nothing carried.</li>}
        {sheet.inventory.map((item) => (
          <li key={item.name}>
            {item.name}
            {item.quantity > 1 && ` ×${item.quantity}`}
            {item.equipped && <span className="role"> equipped</span>}
          </li>
        ))}
      </ul>

      <p>
        <strong>Coin</strong> {sheet.currency.pp}pp {sheet.currency.gp}gp {sheet.currency.sp}sp{' '}
        {sheet.currency.cp}cp
      </p>

      {setHp.error && <p role="alert">Could not save HP — reload and try again.</p>}
    </aside>
  );
}
