/**
 * Mapping the shipped D&D character sheet's form fields onto a `CharacterSheet`
 * (M4.7). Pure: form fields in, an `ImportCharacterRequest` out. No PDF library
 * here, so the whole mapping is unit-testable from a JSON fixture.
 *
 * Two rules shape everything below.
 *
 * **D-3: the sheet stores inputs, never derived values.** The PDF is full of
 * modifiers, saves, skill totals, passive scores and a proficiency bonus. All of
 * them are dropped, because `deriveSheet` recomputes them (FR-401) — an import
 * that trusted the file's own arithmetic would let a player hand us any number
 * they liked. The one place the file's arithmetic is *read* is the proficiency
 * bonus, and only as a check on our own parse.
 *
 * **Nothing disappears quietly.** Everything the schema has no room for comes
 * back in `ignored`, so a player who imports a wizard is told their features and
 * hit dice did not come along rather than discovering it mid-session.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import {
  ABILITIES,
  type Ability,
  type CharacterClass,
  ImportCharacterRequest,
  type Skill,
  characterLevel,
  proficiencyBonus,
} from '@dnd-lm/contracts';
import type { PdfFormField } from './pdf-form';

/** The field name that identifies the sheet at all. */
const IDENTIFYING_FIELD = 'CharacterName';

/** The shipped sheet has 56 equipment rows; the margin costs nothing. */
const MAX_EQUIPMENT_ROWS = 120;

/** PDF field stem → our skill id. The two irregular ones are why this is a table. */
const SKILL_FIELDS: ReadonlyArray<readonly [Skill, string]> = [
  ['acrobatics', 'Acrobatics'],
  ['animal_handling', 'AnimalHandling'],
  ['arcana', 'Arcana'],
  ['athletics', 'Athletics'],
  ['deception', 'Deception'],
  ['history', 'History'],
  ['insight', 'Insight'],
  ['intimidation', 'Intimidation'],
  ['investigation', 'Investigation'],
  ['medicine', 'Medicine'],
  ['nature', 'Nature'],
  ['perception', 'Perception'],
  ['performance', 'Performance'],
  ['persuasion', 'Persuasion'],
  ['religion', 'Religion'],
  ['sleight_of_hand', 'SleightOfHand'],
  ['stealth', 'Stealth'],
  ['survival', 'Survival'],
];

/** `=== 2nd LEVEL ===` → 2, `=== CANTRIPS ===` → 0. */
const SPELL_HEADER_LEVELS: Readonly<Record<string, number>> = {
  CANTRIPS: 0,
  '1ST': 1,
  '2ND': 2,
  '3RD': 3,
  '4TH': 4,
  '5TH': 5,
  '6TH': 6,
  '7TH': 7,
  '8TH': 8,
  '9TH': 9,
};

export type CharacterImportReport = {
  request: ImportCharacterRequest;
  /** Short phrases naming what the schema had no room for. Never empty in practice. */
  ignored: string[];
};

function reject(code: string, message: string): never {
  throw new UnprocessableEntityException({ code, message });
}

/** Trimmed and capped, or absent — an empty or placeholder field is not a value. */
function short(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '--' ? trimmed.slice(0, max) : undefined;
}

const sign = (n: number): string => `${n >= 0 ? '+' : ''}${n}`;

/** Leading signed integer: `"+3"`, `"-2"`, `"30 ft. (Walking)"`, `"20"`. `"--"` is absent. */
function leadingInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([+-]?\d+)/.exec(value);
  return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

/**
 * `"Artificer 5 / Wizard 2"` → two classes. A subclass in parentheses stays part
 * of the name, which is why the level is matched at the end rather than the name
 * at the start.
 */
export function parseClassLine(line: string): CharacterClass[] {
  const classes: CharacterClass[] = [];
  for (const part of line.split('/')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const match = /^(.+?)\s+(\d+)$/.exec(trimmed);
    if (!match) {
      reject(
        'UNREADABLE_CLASS_LINE',
        `Could not read "${line}" as a class and level. Expected something like "Fighter 3" or "Artificer 5 / Wizard 2".`,
      );
    }
    classes.push({ name: match[1] as string, level: Number.parseInt(match[2] as string, 10) });
  }
  if (classes.length === 0) reject('UNREADABLE_CLASS_LINE', 'The sheet names no class or level.');
  return classes;
}

/**
 * Spell level comes from the `=== 1st LEVEL ===` banners, which are their own
 * fields rather than part of the list — so the only thing that ties a spell to
 * its level is where it sits on the page. Read the page the way a person does:
 * top to bottom, and every spell belongs to the last banner above it.
 *
 * ponytail: the shipped sheet lists spells in one column per page, so ordering
 * by descending `y` is enough; `x` is a coarse tiebreak in case a future layout
 * splits them. A spell above the first banner keeps level 0 rather than failing
 * the import — a cantrip mislabelled is better than a sheet refused.
 */
function collectSpells(fields: PdfFormField[]): ImportCharacterRequest['sheet']['spells'] {
  const positioned = fields.filter(
    (field) => /^spellName\d+$/.test(field.name) || /^spellHeader\d+$/.test(field.name),
  );
  const byIndex = new Map<string, Map<string, string>>();
  for (const field of fields) {
    const match = /^spell([A-Za-z]+?)(\d+)$/.exec(field.name);
    if (!match) continue;
    const bucket = byIndex.get(match[2] as string) ?? new Map<string, string>();
    bucket.set(match[1] as string, field.value);
    byIndex.set(match[2] as string, bucket);
  }

  positioned.sort(
    (a, b) => a.page - b.page || Math.round(a.x / 100) - Math.round(b.x / 100) || b.y - a.y,
  );

  const spells: ImportCharacterRequest['sheet']['spells'] = [];
  let level = 0;
  for (const field of positioned) {
    if (field.name.startsWith('spellHeader')) {
      const key = field.value.replace(/=/g, '').trim().split(/\s+/)[0]?.toUpperCase() ?? '';
      const parsed = SPELL_HEADER_LEVELS[key];
      if (parsed !== undefined) level = parsed;
      continue;
    }
    const index = /^spellName(\d+)$/.exec(field.name)?.[1];
    const attributes = index ? byIndex.get(index) : undefined;
    const optional = (key: string): string | undefined => {
      const raw = attributes?.get(key)?.trim();
      return raw && raw !== '--' ? raw : undefined;
    };
    spells.push({
      name: field.value,
      level,
      // "P" is prepared; "O" is known but unprepared, which every cantrip is.
      prepared: attributes?.get('Prepared') === 'P',
      source: optional('Source'),
      castingTime: optional('CastingTime'),
      range: optional('Range'),
      components: optional('Components'),
      duration: optional('Duration'),
      notes: optional('Notes'),
    });
  }
  return spells;
}

export function mapWotcCharacterSheet(
  fields: PdfFormField[],
  /** Echoed back by a caller who saw a `LEVEL_MISMATCH` and chose to proceed. */
  confirmLevel?: number,
): CharacterImportReport {
  const values = new Map<string, string>();
  for (const field of fields) if (!values.has(field.name)) values.set(field.name, field.value);
  const get = (name: string): string | undefined => values.get(name);

  const name = get(IDENTIFYING_FIELD);
  if (!name) {
    reject(
      'NOT_A_CHARACTER_SHEET',
      'That PDF has no character-sheet form fields. Export the sheet from D&D Beyond as a form-fillable PDF rather than printing or flattening it.',
    );
  }

  const classes = parseClassLine(get('CLASS LEVEL') ?? '');

  const abilityScores = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const score = leadingInt(get(ability.toUpperCase()));
    if (score === undefined) {
      reject('MISSING_ABILITY_SCORE', `The sheet has no ${ability.toUpperCase()} score.`);
    }
    abilityScores[ability] = score;
  }

  // A marker of any kind means proficient: saves use "•" and skills use "P".
  const capitalised = (ability: Ability) => ability.charAt(0).toUpperCase() + ability.slice(1);
  const saveProficiencies = ABILITIES.filter((ability) => get(`${capitalised(ability)}Prof`));
  const skillProficiencies = SKILL_FIELDS.filter(([, stem]) => get(`${stem}Prof`)).map(
    ([skill]) => skill,
  );

  // The equipment rows are a fixed grid with gaps in it, so walk the whole grid
  // rather than stopping at the first empty row.
  const inventory: ImportCharacterRequest['sheet']['inventory'] = [];
  for (let index = 0; index < MAX_EQUIPMENT_ROWS; index += 1) {
    const itemName = get(`Eq Name${index}`);
    if (itemName === undefined) continue;
    inventory.push({
      name: itemName.slice(0, 120),
      quantity: Math.min(Math.max(leadingInt(get(`Eq Qty${index}`)) ?? 1, 1), 9999),
      // The sheet has no equipped column; assuming "yes" would arm the character.
      equipped: false,
    });
  }

  const attacks: ImportCharacterRequest['sheet']['attacks'] = [];
  for (let slot = 1; slot <= 12; slot += 1) {
    // The first row is "Wpn Name"; the rest are "Wpn Name 2", "Wpn Name 3"…
    const attackName = get(slot === 1 ? 'Wpn Name' : `Wpn Name ${slot}`);
    if (!attackName) continue;
    const damage = get(`Wpn${slot} Damage`);
    const notes = get(`Wpn Notes ${slot}`);
    attacks.push({
      name: attackName.slice(0, 60),
      attackBonus: leadingInt(get(`Wpn${slot} AtkBonus`)),
      damage: damage?.slice(0, 60),
      notes: notes?.slice(0, 160),
    });
  }

  const maxHp = leadingInt(get('MaxHP'));
  if (maxHp === undefined) reject('MISSING_HP', 'The sheet has no maximum HP.');
  const armorClass = leadingInt(get('AC'));
  if (armorClass === undefined) reject('MISSING_AC', 'The sheet has no armour class.');

  const request = ImportCharacterRequest.parse({
    name: name.slice(0, 80),
    sheet: {
      classes,
      race: short(get('RACE'), 40),
      background: short(get('BACKGROUND'), 60),
      hitDice: short(get('Total'), 40),
      senses: short(get('AdditionalSenses'), 80),
      abilityScores,
      skillProficiencies,
      saveProficiencies,
      maxHp,
      armorClass,
      speed: leadingInt(get('Speed')) ?? 30,
      inventory: inventory.slice(0, 200),
      currency: {
        cp: leadingInt(get('CP')) ?? 0,
        sp: leadingInt(get('SP')) ?? 0,
        gp: leadingInt(get('GP')) ?? 0,
        pp: leadingInt(get('PP')) ?? 0,
      },
      attacks: attacks.slice(0, 40),
      spells: collectSpells(fields).slice(0, 400),
    },
  });

  // The file's own proficiency bonus is the one derived number worth reading: it
  // is a function of level alone, so disagreeing with it means the class line was
  // misread. Importing a level-7 character as a level-5 one would quietly corrupt
  // every roll they make, so this refuses rather than guessing.
  const statedBonus = leadingInt(get('ProfBonus'));
  const parsedLevel = characterLevel(request.sheet.classes);
  const derivedBonus = proficiencyBonus(parsedLevel);
  if (statedBonus !== undefined && statedBonus !== derivedBonus && confirmLevel !== parsedLevel) {
    // The override has to *echo the level back*, so importing anyway is a decision
    // someone made after seeing the number rather than a blind retry.
    throw new UnprocessableEntityException({
      code: 'LEVEL_MISMATCH',
      message: `The sheet says its proficiency bonus is ${sign(statedBonus)}, but "${get('CLASS LEVEL')}" reads as level ${parsedLevel}, whose bonus is ${sign(derivedBonus)}. Refusing rather than importing at the wrong level — confirm level ${parsedLevel} to import anyway.`,
      parsedLevel,
      statedBonus,
      derivedBonus,
    });
  }

  return { request, ignored: describeIgnored(values, request) };
}

/** Everything the schema has no room for, named so the player can see the gap. */
function describeIgnored(values: Map<string, string>, request: ImportCharacterRequest): string[] {
  const ignored: string[] = [];
  const note = (label: string, field: string) => {
    const value = values.get(field);
    if (value && value !== '--') ignored.push(`${label} (${value.split('\n')[0]?.slice(0, 60)})`);
  };

  // race, background, hit dice and senses are imported now (M4.7 follow-up), so
  // only what still has nowhere to go is listed here.
  note('experience points', 'EXPERIENCE POINTS');
  note('temporary HP', 'TempHP');

  const electrum = leadingInt(values.get('EP')) ?? 0;
  if (electrum > 0) ignored.push(`${electrum} electrum pieces (no electrum in the sheet's purse)`);

  if (values.get('ProficienciesLang')) ignored.push('proficiencies and languages');
  if ([...values.keys()].some((key) => key.startsWith('FeaturesTraits')))
    ignored.push('features and traits');
  if ([...values.keys()].some((key) => key.startsWith('Actions'))) ignored.push('actions');
  if (values.get('PersonalityTraits') || values.get('Ideals') || values.get('Bonds'))
    ignored.push('personality, ideals, bonds and flaws');

  ignored.push(
    `all modifiers, saves and passive scores — recomputed from the ${request.sheet.classes.length > 1 ? 'classes' : 'class'} and ability scores rather than trusted (D-3)`,
  );
  return ignored;
}
