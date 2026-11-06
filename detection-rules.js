/*
 * Deterministic detectors and context-aware filtering for local PII findings.
 *
 * Every rule here runs after (or alongside) the NER model. The goal is to keep
 * real personal data while rejecting look-alikes: dates that resemble phone
 * numbers, version strings that resemble IP addresses, identifiers in code,
 * and public places or companies mentioned without any personal context.
 * Functions are pure so they can be unit-tested without a model.
 */

import {
  CODE_REFERENCE,
  PLACEHOLDER_SECRET,
  finding,
  groupFinding,
  shannonEntropy,
  technicalFindings,
} from "./technical-rules.js";

export { shannonEntropy };

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// Builds a case-insensitive literal (e.g. "my name is" -> "[mM][yY]\s+...")
// so that capture groups can stay case-sensitive.
function ci(phrase) {
  return phrase
    .split(/\s+/)
    .map((word) => [...word].map((ch) =>
      /\p{L}/u.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    ).join(""))
    .join("\\s+");
}

function contextBefore(text, start, size = 40) {
  return text.slice(Math.max(0, start - size), start).toLowerCase();
}

// --- Contact details -------------------------------------------------------

const RESERVED_EMAIL_DOMAIN = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:test|invalid|example|localhost))$/i;

function emailFindings(text) {
  return [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)]
    .filter((match) => !RESERVED_EMAIL_DOMAIN.test(match[0]))
    .map((match) => finding("EMAIL", match[0], match.index));
}

const PHONE_CONTEXT = /(?:phone|tel|mobile|cell|call|text|whats\s?app|contact|number|reach|fax|sms)\W{0,12}[\w\s]{0,12}$/;
const NOT_PHONE_CONTEXT = /\b(?:order|invoice|ticket|tracking|reference|ref|issue|build|id|isbn|serial|version)\b[^\d]{0,12}$/;
const DATE_LIKE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})(?:\s+\d{1,2})?$/;
const FORMATTED_PHONE = /^\(?\d{2,5}\)?[ .-]\d{3,4}[ .-]?\d{4}$/;

export function isLikelyPhone(value, text, start) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  if (DATE_LIKE.test(value)) return false;
  if (/^\d+(?:\.\d+)+$/.test(value)) return false; // decimals and versions
  if (/^(\d)\1+$/.test(digits)) return false;
  if (NOT_PHONE_CONTEXT.test(contextBefore(text, start, 24))) return false;
  if (PHONE_CONTEXT.test(contextBefore(text, start))) return true;
  if (value.startsWith("+")) return true;
  return FORMATTED_PHONE.test(value);
}

function phoneFindings(text) {
  return [...text.matchAll(/(?<![\w.+])\+?\(?\d[\d ().-]{5,}\d(?!\w|\.\d)/g)]
    .map((match) => ({ value: match[0].trimEnd(), index: match.index }))
    .filter(({ value, index }) => isLikelyPhone(value, text, index))
    .map(({ value, index }) => finding("PHONE", value, index));
}

// --- Financial and network identifiers -------------------------------------

export function passesLuhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function cardFindings(text) {
  return [...text.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)]
    .filter((match) => {
      const digits = match[0].replace(/\D/g, "");
      return digits.length >= 13 &&
        digits.length <= 19 &&
        !/^(\d)\1+$/.test(digits) &&
        passesLuhn(digits);
    })
    .map((match) => finding("CREDIT_CARD", match[0], match.index));
}

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;

export function isValidIban(value) {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

function ibanFindings(text) {
  return [...text.matchAll(IBAN)]
    .filter((match) => isValidIban(match[0]))
    .map((match) => finding("ACCOUNT_NUMBER", match[0], match.index));
}

const NON_IDENTIFYING_IPS = new Set(["0.0.0.0", "127.0.0.1", "255.255.255.255"]);

export function isValidIpv4(value) {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) =>
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255 && (octet === "0" || !octet.startsWith("0"))
  );
}

function ipFindings(text) {
  return [...text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\w)/g)]
    .filter((match) =>
      isValidIpv4(match[0]) &&
      !NON_IDENTIFYING_IPS.has(match[0]) &&
      !/\b(?:v|ver|version)\s*$/i.test(contextBefore(text, match.index, 10))
    )
    .map((match) => finding("IP_ADDRESS", match[0], match.index));
}

// --- Secrets ----------------------------------------------------------------

const KNOWN_SECRET_PATTERNS = [
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  // AWS access key IDs (AKIA/ASIA) and IAM unique IDs for users, roles, groups and policies.
  /\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|(?:AIDA|AROA|AGPA|AIPA|ANPA|ANVA)[0-9A-Z]{16,17})\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\bsh(?:pat|pss|pca)_[0-9a-f]{32}\b/g,
  /\bdop_v1_[0-9a-f]{64}\b/g,
  /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  /\bhttps:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[\w-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function looksRandom(value) {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && shannonEntropy(value) >= 3.5;
}

const ASSIGNED_SECRET = new RegExp(
  `\\b(?:${["api key", "api_key", "apikey", "secret", "token", "password", "passwd", "pwd", "passcode", "pin"].map(ci).join("|")})` +
  `\\s*(is|=|:)\\s*["'\`]?([^\\s"'\`]{6,})`,
  "g",
);

function secretFindings(text) {
  const known = KNOWN_SECRET_PATTERNS.flatMap((regex) =>
    [...text.matchAll(regex)].map((match) => finding("API_KEY", match[0], match.index))
  );
  const generic = [...text.matchAll(/\b(?:api|key|token|secret)[_-][A-Za-z0-9_-]{16,}\b/gi)]
    .filter((match) => looksRandom(match[0]))
    .map((match) => finding("API_KEY", match[0], match.index));
  const assigned = [...text.matchAll(ASSIGNED_SECRET)].flatMap((match) => {
    const value = match[2].replace(/[;,.]+$/, "");
    if (PLACEHOLDER_SECRET.test(value) || CODE_REFERENCE.test(value)) return [];
    // "my password is correct" is prose; after "is", require a password-like value.
    const passwordLike = /[\d\W_]/.test(value) || (/\p{Lu}/u.test(value) && /\p{Ll}/u.test(value));
    if (match[1].toLowerCase() === "is" && !passwordLike) return [];
    return [finding("SECRET", value, match.index + match[0].lastIndexOf(match[2]))];
  });
  // The whole key block is redacted; matching only the header would leak the key body.
  const privateKeys = [...text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g)]
    .map((match) => finding("PRIVATE_KEY", match[0], match.index));
  return [...privateKeys, ...known, ...generic, ...assigned];
}

// --- Contextual dates, names, and employers --------------------------------

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const DATE_OF_BIRTH = new RegExp(
  "\\b(?:date\\s+of\\s+birth|d\\.?o\\.?b\\.?|born\\s+(?:on\\s+)?|birthday|birth\\s+date)\\s*(?:is|:|-)?\\s*(" +
  "(?:19|20)\\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.]" + DAY +
  `|${DAY}[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)?\\d{2}` +
  `|${MONTH}\\.?\\s+${DAY}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}` +
  `|${DAY}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+(?:19|20)\\d{2}` +
  ")\\b",
  "gi",
);

function dateOfBirthFindings(text) {
  return [...text.matchAll(DATE_OF_BIRTH)].map((match) => groupFinding("DATE_OF_BIRTH", match));
}

// Words that commonly follow "I'm"/"I am" or "work at" but are not names.
const NOT_A_NAME = new Set([
  "a", "an", "the", "not", "so", "very", "really", "just", "also", "still", "here", "there", "now",
  "sorry", "fine", "good", "great", "ok", "okay", "sure", "ready", "happy", "glad", "back", "done",
  "going", "trying", "looking", "working", "using", "writing", "building", "learning", "new", "interested",
  "in", "at", "on", "from", "with", "for", "to", "of", "about", "home", "night", "least", "currently",
  "english", "french", "spanish", "arabic", "urdu", "german", "chinese", "american", "british",
]);

const NAME_WORD = "\\p{Lu}[\\p{L}\\p{M}'’-]+";
const ANY_NAME_WORD = "\\p{L}[\\p{L}\\p{M}'’-]+";
const ORG_WORD = "\\p{Lu}[\\p{L}\\p{M}\\p{N}&.'’-]*";

const CONTEXTUAL_PATTERNS = [
  // "my name is momina" is unambiguous, so lowercase names are accepted.
  ["PERSON", new RegExp(`\\b(?:${ci("my name is")}|${ci("my name's")}|${ci("call me")})\\s+(${ANY_NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`, "gu")],
  // "I'm happy" must not become a name, so these require capitalized words.
  ["PERSON", new RegExp(`(?<![\\p{L}])(?:[Ii]['’]?[Mm]|[Ii]\\s+[Aa][Mm])\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`, "gu")],
];

const EMPLOYMENT = `(?:${["work at", "work for", "works at", "works for", "working at", "working for", "worked at", "worked for", "employed by", "employed at"].map(ci).join("|")})`;
const CAPITALIZED_EMPLOYER = new RegExp(`\\b${EMPLOYMENT}\\s+(${ORG_WORD}(?:\\s+(?:&\\s+)?${ORG_WORD}){0,3})`, "gu");
const LOWERCASE_EMPLOYER = new RegExp(`\\b${EMPLOYMENT}\\s+(\\p{Ll}[\\p{L}\\p{M}\\p{N}&'’-]{2,})(?![\\p{L}\\p{N}])`, "gu");

// Pronouns and generic employer words that some vocabularies split into pieces.
const ORDINARY_WORDS = new Set([
  "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves", "me", "you", "him",
  "her", "us", "them", "someone", "anyone", "everyone", "nobody",
  "startup", "nonprofit", "ngo", "freelance", "freelancing", "charity", "agency", "contractor", "fintech",
]);

function inflectionStems(word) {
  const stems = [word];
  if (word.endsWith("ies")) stems.push(`${word.slice(0, -3)}y`);
  for (const suffix of ["es", "s", "ing", "ed", "ers", "er"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) stems.push(word.slice(0, -suffix.length));
  }
  return stems;
}

/**
 * A lowercase word is an ordinary word if the model vocabulary stores it (or
 * its stem) as one token. Names and acronyms such as "unicef" are rare in
 * lowercase, so tokenizers split them into pieces ("un", "##ice", "##f").
 */
export function isOrdinaryWord(word, isSingleToken) {
  return inflectionStems(word.toLowerCase()).some((stem) => {
    if (NOT_A_NAME.has(stem) || ORDINARY_WORDS.has(stem)) return true;
    try {
      return isSingleToken(stem);
    } catch {
      return true;
    }
  });
}

const COMPANY_SUFFIX = new Set(["inc", "corp", "ltd", "co", "llc", "plc", "gmbh", "sa", "ag", "bv", "nv", "pty", "pvt"]);

/** "Initech Corp. You" -> "Initech Corp."; "Acme. Then" -> "Acme". */
export function trimEmployer(value) {
  const words = value.split(/\s+/);
  const kept = [];
  for (const word of words) {
    if (!word.endsWith(".") || /\.[^.]/.test(word)) { kept.push(word); continue; }
    const bare = word.slice(0, -1);
    kept.push(COMPANY_SUFFIX.has(bare.toLowerCase()) ? word : bare);
    break;
  }
  return kept.join(" ");
}

function employerFinding(match) {
  const trimmed = trimEmployer(match[1]);
  return finding("ORGANIZATION", trimmed, match.index + match[0].lastIndexOf(match[1]));
}

function contextualFindings(text, { isSingleToken } = {}) {
  const names = CONTEXTUAL_PATTERNS.flatMap(([type, regex]) =>
    [...text.matchAll(regex)]
      .filter((match) => !NOT_A_NAME.has(match[1].split(/\s+/)[0].toLowerCase()))
      .map((match) => groupFinding(type, match))
  );
  const employers = [...text.matchAll(CAPITALIZED_EMPLOYER)]
    .filter((match) => !NOT_A_NAME.has(match[1].split(/\s+/)[0].toLowerCase()))
    .map(employerFinding);
  // "working for unicef": without a vocabulary to separate it from "working
  // for hours", lowercase employers are skipped rather than guessed.
  const lowercaseEmployers = isSingleToken
    ? [...text.matchAll(LOWERCASE_EMPLOYER)]
      .filter((match) => !isOrdinaryWord(match[1], isSingleToken))
      .map((match) => groupFinding("ORGANIZATION", match))
    : [];
  return [...names, ...employers, ...lowercaseEmployers];
}

/** All deterministic findings, ordered by redaction priority. */
/**
 * `options.isSingleToken(word)` lets the caller supply the loaded model's
 * vocabulary so lowercase employers can be recognized.
 */
export function patternFindings(text, options = {}) {
  // resolveFindings drops overlaps (earlier wins), so a value matched by two
  // detectors (e.g. "password: x" and a named-secret rule) is reported once.
  return resolveFindings([
    ...technicalFindings(text),
    ...secretFindings(text),
    ...emailFindings(text),
    ...cardFindings(text),
    ...ibanFindings(text),
    ...ipFindings(text),
    ...phoneFindings(text),
    ...dateOfBirthFindings(text),
    ...contextualFindings(text, options),
  ]);
}

// --- Model output filtering ------------------------------------------------

/** Character ranges of fenced (```) and inline (`) code. */
export function codeRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function insideRanges(ranges, start, end) {
  return ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);
}

const PERSONAL_RELATION = /\b(?:live[sd]?|living|reside[sd]?|resident|address|home|born|from|moved?|moving|based|located|stay(?:s|ing)?|work(?:s|ed|ing)?|employ(?:ed|er|ee)|office|job|school|stud(?:y|ies|ying|ent)|attend(?:s|ing)?|hospital|clinic|patient|client|customer|case|family|child|children|visit(?:s|ing)?|travel(?:l?ing)?|trip|appointment|meet(?:ing)?)\b/i;
// Sentence-initial pronouns are capitalized ("My son…", "She lives…"); only the
// first letter is case-insensitive so that "US" is not read as "us".
const PERSONAL_SUBJECT = new RegExp(`\\b(?:${
  ["i", "i'm", "i’m", "me", "my", "mine", "myself", "we", "our", "ours", "us", "he", "she", "his", "her", "hers", "him", "they", "their", "them"]
    .map((word) => `[${word[0]}${word[0].toUpperCase()}]${word.slice(1)}`)
    .join("|")
})\\b`);

function sentenceBounds(text, start, end) {
  const before = text.slice(0, start);
  const sentenceStart = Math.max(...[".", "!", "?", "\n"].map((mark) => before.lastIndexOf(mark))) + 1;
  const after = text.slice(end).search(/[.!?\n]/);
  return [sentenceStart, after === -1 ? text.length : end + after];
}

/**
 * Organizations and locations are only private when they describe someone
 * ("I live in Lahore", "Ali works at UNICEF"). A question about "Paris" or a
 * comparison of "Microsoft and Google" carries no personal context.
 */
function hasPersonalContext(text, entity, personSpans) {
  const [start, end] = sentenceBounds(text, entity.start, entity.end);
  if (personSpans.some(([personStart]) => personStart >= start && personStart < end)) return true;
  const sentence = text.slice(start, entity.start) + " " + text.slice(entity.end, end);
  return PERSONAL_RELATION.test(sentence) && PERSONAL_SUBJECT.test(sentence);
}

const NON_PII_LABELS = new Set(["MISC", "O"]);
const GREETINGS = new Set(["hi", "hello", "hey", "dear", "thanks", "thank", "please", "regards", "cheers"]);

/**
 * Removes model findings that are not plausible PII and marks context-free
 * organizations/locations as `weak` (shown to the user but not pre-selected
 * and not enough on their own to interrupt sending).
 */
export function filterModelEntities(entities, text, policy, contextFindings = []) {
  const code = codeRanges(text);
  const thresholds = policy.typeThresholds || {};
  const kept = entities.filter((entity) => {
    const value = String(entity.value || "").trim();
    if (NON_PII_LABELS.has(entity.type)) return false;
    if (entity.score < (thresholds[entity.type] ?? policy.minimumConfidence)) return false;
    if (value.length < 2 || !/\p{L}/u.test(value)) return false;
    if (GREETINGS.has(value.toLowerCase())) return false;
    if (Number.isInteger(entity.start) && Number.isInteger(entity.end)) {
      // Tokenizer fragments such as "ever" inside "evergreen".
      if (WORD_CHAR.test(text[entity.start - 1] || "") || WORD_CHAR.test(text[entity.end] || "")) return false;
      if (insideRanges(code, entity.start, entity.end)) return false;
    }
    // Cased-script values with no capital letters are usually ordinary words.
    if (/\p{Ll}/u.test(value) && !/\p{Lu}/u.test(value) && entity.score < 0.95) return false;
    return true;
  });

  const gated = new Set(policy.contextRequiredTypes || []);
  const personSpans = [...kept, ...contextFindings]
    .filter((entity) => ["PER", "PERSON"].includes(entity.type) && Number.isInteger(entity.start))
    .map((entity) => [entity.start, entity.end]);
  return kept.map((entity) =>
    gated.has(entity.type) && Number.isInteger(entity.start) && !hasPersonalContext(text, entity, personSpans)
      ? { ...entity, weak: true }
      : entity
  );
}

/**
 * Resolves overlapping findings. Earlier items win, so callers pass pattern
 * findings (priority-ordered) before model findings. Every occurrence is kept;
 * deduplicating by value would leave a second "Momina" unredacted.
 */
export function resolveFindings(findings) {
  const accepted = [];
  for (const item of findings) {
    if (!item.value) continue;
    const hasOffsets = Number.isInteger(item.start) && Number.isInteger(item.end);
    const overlaps = accepted.some((other) =>
      hasOffsets && Number.isInteger(other.start)
        ? item.start < other.end && item.end > other.start
        : other.type === item.type && other.value.toLowerCase() === item.value.toLowerCase()
    );
    if (!overlaps) accepted.push(item);
  }
  return accepted;
}
