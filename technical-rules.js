/*
 * Deterministic detectors for technical identifiers: cloud accounts and
 * resources, credentials embedded in URLs and config, network addresses,
 * internal hostnames, usernames in file paths, and government/bank IDs.
 *
 * These values rarely appear in names-and-places NER training data, yet they
 * identify people, organizations and infrastructure just as well. Everything
 * here is a pure function of the text so it can be unit-tested without a model.
 * Detectors prefer precision: a label ("account id", "passport") or a checksum
 * or strict format is required unless the format alone is unambiguous.
 */

export function finding(type, value, start, extra = {}) {
  return { type, value, source: "pattern-detector", score: 1, start, end: start + value.length, ...extra };
}

export function groupFinding(type, match, group = 1) {
  const value = match[group];
  return finding(type, value, match.index + match[0].lastIndexOf(value));
}

export function shannonEntropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// --- Shared value filters ---------------------------------------------------

export const PLACEHOLDER_SECRET = /^(?:\*+|x+|\.+|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|null|none|undefined|example|changeme|your\w*|string|str|number|boolean|bool|required|optional|hidden|text|input|password|secret|token|true|false)$/i;
// Environment variables, template expressions, and property paths are references, not secrets.
export const CODE_REFERENCE = /^(?:\$\{[^}]*\}|\$\w+|%\w+%|\{\{.*\}\}|[A-Z][A-Z0-9_]*|[\w$]+(?:\.[\w$]+)+|[\w$.]+[(\[].*)$/;
const FILE_NAME = /^[\w./-]+\.(?:json|ya?ml|txt|pem|key|env|js|ts|py|cfg|conf|ini|png|csv|md|log)$/i;

export function isPlaceholderOrReference(value) {
  return PLACEHOLDER_SECRET.test(value) || CODE_REFERENCE.test(value);
}

/** Letters plus digits or symbols: the shape of a generated secret or a real password. */
function secretShaped(value) {
  return value.length >= 8 &&
    /[A-Za-z]/.test(value) &&
    (/\d/.test(value) || /[!@#$%^&*+/=]/.test(value)) &&
    !isPlaceholderOrReference(value) &&
    !FILE_NAME.test(value) &&
    !/^(?:https?:|\/|\.\/|~)/i.test(value);
}

function looksRandom(value) {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && shannonEntropy(value) >= 3.5;
}

const matches = (regex, text) => [...text.matchAll(regex)];

// --- Credentials in config, headers and URLs -------------------------------

const SECRET_NAME = "[\\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|signing[_-]?key|encryption[_-]?key|credential|authorization)[\\w.-]*";
// `AWS_SECRET_ACCESS_KEY=…`, `"client_secret": "…"`, `x-api-key: …`, `DB_PASSWORD = …`.
const NAMED_SECRET = new RegExp(`(?<![\\w?&])(${SECRET_NAME})["']?\\s*[:=]\\s*["'\`]?([^\\s"'\`,;]{8,})`, "gi");

const QUERY_SECRET = /[?&](?:access_token|id_token|refresh_token|token|api[_-]?key|apikey|key|sig|signature|password|secret|client_secret|x-amz-signature|x-amz-security-token|x-amz-credential)=([^&\s#"'<>]{8,})/gi;

function credentialFindings(text) {
  const named = matches(NAMED_SECRET, text)
    .filter((match) => secretShaped(match[2].replace(/[.]+$/, "")))
    .map((match) => groupFinding("SECRET", match, 2));
  const query = matches(QUERY_SECRET, text)
    .filter((match) => secretShaped(match[1]))
    .map((match) => groupFinding("SECRET", match));
  const bearer = matches(/\bBearer\s+([A-Za-z0-9._~+/-]{16,}={0,2})/g, text)
    .filter((match) => looksRandom(match[1]) && !PLACEHOLDER_SECRET.test(match[1]))
    .map((match) => groupFinding("API_KEY", match));
  const basic = matches(/\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})/g, text)
    .filter((match) => looksRandom(match[1]))
    .map((match) => groupFinding("SECRET", match));
  const azure = matches(/\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=([A-Za-z0-9+/%=]{30,})/g, text)
    .map((match) => groupFinding("SECRET", match));
  return [...named, ...query, ...bearer, ...basic, ...azure, ...awsSecretKeyNearAccessKey(text)];
}

// Secret access keys are 40 base64 characters with no prefix. Alone they are
// indistinguishable from other hashes, but next to an access key ID they are not.
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

function awsSecretKeyNearAccessKey(text) {
  const found = [];
  for (const id of matches(AWS_ACCESS_KEY_ID, text)) {
    const from = Math.max(0, id.index - 160);
    const window = text.slice(from, id.index + id[0].length + 160);
    for (const candidate of window.matchAll(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g)) {
      const value = candidate[0];
      if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && shannonEntropy(value) >= 4) {
        found.push(finding("SECRET", value, from + candidate.index));
      }
    }
  }
  return found;
}

const DATA_SCHEMES = new Set([
  "postgres", "postgresql", "mysql", "mariadb", "mongodb", "mongodb+srv", "redis", "rediss", "amqp", "amqps",
  "mssql", "sqlserver", "cassandra", "ftp", "ftps", "sftp", "ssh", "smb", "ldap", "ldaps", "hdfs",
]);
const INTERNAL_SUFFIX = /\.(?:internal|corp|intranet|lan|local|localdomain|home\.arpa|private)$/i;
const REFERENCE_HOSTS = /^(?:localhost|host(?:name)?|server|db|database|your[\w.-]*|my[\w.-]*|<.*>|\{.*\}|\$.*|(?:[\w-]+\.)*example\.(?:com|org|net)|[\w.-]+\.(?:test|invalid|example))$/i;
const PLACEHOLDER_PASSWORD = /^(?:pass(?:word)?|secret|x+|\*+|<.*>|\{.*\}|\[.*\]|\$.*|your.*)$/i;
const SHARE_LINK_HOSTS = /^(?:docs|drive|meet)\.google\.com$|^(?:www\.)?(?:dropbox|box|figma|airtable|notion)\.(?:com|so)$|^(?:1drv\.ms|onedrive\.live\.com|teams\.microsoft\.com)$/i;
const TENANT_HOST = /^([a-z0-9-]+)\.(?:atlassian\.net|sharepoint\.com|zoom\.us|slack\.com|okta\.com|my\.salesforce\.com|notion\.site)$/i;
const PUBLIC_SUBDOMAINS = new Set(["www", "api", "app", "apps", "support", "help", "docs", "developer", "developers", "status", "community", "marketplace", "blog", "us02web", "events", "hooks", "files", "join"]);

/**
 * URLs are private when they embed credentials, point at a database/file
 * service or an internal host, or are a document/meeting link that grants
 * access. Ordinary public URLs are left alone.
 */
export function isPrivateUrl(url) {
  const parts = url.match(/^([a-z][a-z0-9+.-]*):\/\/(?:([^/@\s]*)@)?([^/:?#\s]*)(?::\d+)?([^\s]*)/i);
  if (!parts) return false;
  const scheme = parts[1].toLowerCase();
  const userInfo = parts[2];
  const host = parts[3].toLowerCase();
  const path = parts[4] || "";
  if (!host || REFERENCE_HOSTS.test(host)) {
    // Credentials are sensitive even on localhost.
    return Boolean(userInfo && realPassword(userInfo));
  }
  if (userInfo && realPassword(userInfo)) return true;
  if (DATA_SCHEMES.has(scheme)) return true;
  if (INTERNAL_SUFFIX.test(host)) return true;
  const tenant = host.match(TENANT_HOST);
  if (tenant && !PUBLIC_SUBDOMAINS.has(tenant[1])) return true;
  return SHARE_LINK_HOSTS.test(host) && /[A-Za-z0-9_-]{16,}/.test(path);
}

function realPassword(userInfo) {
  const colon = userInfo.indexOf(":");
  return colon !== -1 && userInfo.length > colon + 1 && !PLACEHOLDER_PASSWORD.test(userInfo.slice(colon + 1));
}

function urlFindings(text) {
  return matches(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]+/gi, text)
    .map((match) => ({ value: match[0].replace(/[.,;:!?]+$/, ""), index: match.index }))
    .filter(({ value }) => isPrivateUrl(value))
    .map(({ value, index }) => finding("PRIVATE_URL", value, index));
}

// --- Cloud accounts and resources --------------------------------------------

// arn:aws:iam::123456789012:role/Admin, arn:aws:s3:::company-bucket/key
const ARN = /\barn:aws[a-z-]*:([a-z0-9-]+):([a-z0-9-]*):(\d{12}|aws|):([^\s"'`<>,;)\]]+)/g;

const ACCOUNT_LABEL = /\b((?:aws|iam|sts|sso|org(?:anization)?|root|member|management|cloud)?[\s_-]*account)(?:[\s_-]*(id|number|no\.?|num|#))?["']?\s*(?:is|=>?|:|-)?\s*["']?(\d{4}-\d{4}-\d{4}(?:-\d{4})?|\d{8,17})(?![\d-])/gi;

const AWS_RESOURCE_ID = /\b(?:i|vpc|subnet|sg|vol|ami|eni|igw|rtb|acl|snap|nat|tgw|pcx|eipalloc|eipassoc)-(?=[0-9a-f]*\d)[0-9a-f]{8}(?:[0-9a-f]{9})?\b/g;

const AWS_ENDPOINT = new RegExp([
  // mydb.cluster-abc123.us-east-1.rds.amazonaws.com, 123456789012.dkr.ecr.us-east-1.amazonaws.com
  String.raw`\b(?:[a-z0-9-]+\.)+(?:rds|redshift|docdb|neptune|elb|elasticache|es|kafka|efs|execute-api|dkr\.ecr|cache)\.(?:[a-z0-9-]+\.)*amazonaws\.com(?:\.cn)?\b`,
  String.raw`\b\d{12}\.dkr\.ecr[a-z0-9.-]*\.amazonaws\.com\b`,
  String.raw`\b[a-z0-9][a-z0-9.-]{2,62}\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com\b`,
  // elasticloadbalancing hostnames look like name-123456789.us-east-1.elb.amazonaws.com
].join("|"), "gi");

const BUCKET_URI = /\b(?:s3|gs):\/\/[a-z0-9][a-z0-9._-]{2,62}(?:\/[^\s"'`<>)\]]*)?/gi;

const GUID = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
const AZURE_ID = new RegExp(`\\b(?:subscription|tenant|directory|principal|object|client|app(?:lication)?)[\\s_-]*(?:id)?["']?\\s*(?:is|=|:|-)?\\s*["']?(${GUID})\\b`, "gi");
const GCP_PROJECT = /(?:\bproject[\s_-]*id|--project|\bGOOGLE_CLOUD_PROJECT|\bGCLOUD_PROJECT)["']?\s*(?:=|:|\s)\s*["']?([a-z][a-z0-9-]{4,28}[a-z0-9])\b/gi;
const GOOGLE_OAUTH_CLIENT = /\b\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/g;

function cloudFindings(text) {
  const arns = matches(ARN, text)
    .map((match) => ({ match, value: match[0].replace(/[.:]+$/, "") }))
    .filter(({ match }) => match[3] !== "aws" && match[4] !== "*")
    .map(({ match, value }) => finding("CLOUD_RESOURCE", value, match.index));

  const accounts = matches(ACCOUNT_LABEL, text).flatMap((match) => {
    const [, label, qualifier, digits] = match;
    const compact = digits.replace(/-/g, "");
    const cloud = /aws|iam|sts|sso|org|root|member|management|cloud/i.test(label) || /^id$/i.test(qualifier || "") || digits.includes("-");
    if (compact.length === 12 && (cloud || !qualifier)) return [groupFinding("CLOUD_ACCOUNT_ID", match, 3)];
    // "account 12345678" with no qualifier is too ambiguous (dates, counts).
    if (qualifier && compact.length >= 8) return [groupFinding("ACCOUNT_NUMBER", match, 3)];
    return [];
  });

  const resources = [AWS_RESOURCE_ID, AWS_ENDPOINT, BUCKET_URI, GOOGLE_OAUTH_CLIENT]
    .flatMap((regex) => matches(regex, text))
    .map((match) => finding("CLOUD_RESOURCE", match[0].replace(/[.,;:!?]+$/, ""), match.index));

  const tenants = matches(AZURE_ID, text).map((match) => groupFinding("CLOUD_ACCOUNT_ID", match));
  const projects = matches(GCP_PROJECT, text)
    .filter((match) => /[-\d]/.test(match[1]))
    .map((match) => groupFinding("CLOUD_ACCOUNT_ID", match));
  return [...arns, ...accounts, ...resources, ...tenants, ...projects];
}

// --- Network addresses and hostnames -----------------------------------------

export function isValidIpv6(value) {
  if (!/^[0-9a-f:]+$/i.test(value) || value.includes(":::")) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  if (halves.length === 1) return groups.length === 8;
  // Compressed form. "::1" (loopback) and C++-style "a::b" are not identifying.
  return groups.length >= 2 && groups.length <= 7 && groups.some((group) => group.length > 1);
}

function networkFindings(text) {
  const ipv6 = matches(/(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])(?!\.\d)/gi, text)
    .filter((match) => isValidIpv6(match[0]))
    .map((match) => finding("IP_ADDRESS", match[0], match.index));

  const mac = matches(/(?<![\w:-])[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![\w:-])/gi, text)
    .filter((match) => !/^(?:00|ff)(?:[:-](?:00|ff)){5}$/i.test(match[0]))
    .map((match) => finding("MAC_ADDRESS", match[0], match.index));

  const hosts = matches(/(?<![\w./@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:internal|corp|intranet|lan|local|localdomain|home\.arpa|private)(?![\w-])/gi, text)
    // ".env.local", "config.local" and similar are file names, not machines.
    .filter((match) => !/^(?:env|config|settings|secrets?|application|appsettings)\./i.test(match[0]))
    .map((match) => finding("INTERNAL_HOST", match[0], match.index));
  return [...ipv6, ...mac, ...hosts];
}

// --- Usernames in file paths -------------------------------------------------

const GENERIC_ACCOUNTS = new Set([
  "shared", "public", "default", "all users", "user", "users", "username", "root", "admin", "administrator",
  "runner", "ubuntu", "ec2-user", "node", "app", "appuser", "vagrant", "circleci", "jenkins", "build", "ci",
  "me", "you", "name", "yourname", "your-name", "your_username", "home", "guest", "nobody", "www-data", "deploy",
]);

// /Users/jane/…, /home/jane/…, C:\Users\Jane\…
const HOME_PATH = /(?<![\w])(?:\/Users|\/home|[A-Za-z]:[\\/]Users)[\\/]([^\\/\s"'`:;,)<>*|?$%{}[\]~]+)/g;

function pathFindings(text) {
  return matches(HOME_PATH, text)
    .filter((match) => match[1].length >= 2 && !GENERIC_ACCOUNTS.has(match[1].toLowerCase()))
    .map((match) => groupFinding("USERNAME", match));
}

// --- Government and bank identifiers ------------------------------------------

export function isValidSsn(value) {
  const [area, group, serial] = value.split("-");
  return area !== "000" && area !== "666" && area < "900" && group !== "00" && serial !== "0000";
}

const NATIONAL_ID_LABEL = /\b(?:ssn|social\s+security(?:\s+(?:number|no\.?))?|cnic|national\s+(?:id|identity)(?:\s+(?:number|no\.?|card))?|passport(?:\s+(?:number|no\.?|#))?|aadhaa?r|national\s+insurance(?:\s+number)?|nino|driver'?s\s+licen[sc]e(?:\s+(?:number|no\.?|#))?|tax\s+id)\b[\s:#=-]*(?:(?:number|no\.?|id|is)\b[\s:#=-]*)?(\d{3,5}[ -]\d{2,7}[ -]\d{1,7}|[A-Z0-9][A-Z0-9-]{4,18}[A-Z0-9])\b/gi;

function identityFindings(text) {
  const ssn = matches(/(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g, text)
    .filter((match) => isValidSsn(match[0]))
    .map((match) => finding("NATIONAL_ID", match[0], match.index));
  // Pakistani CNIC: 5-7-1 digits, first digit is the province code.
  const cnic = matches(/(?<![\d-])[1-8]\d{4}-\d{7}-\d(?![\d-])/g, text)
    .map((match) => finding("NATIONAL_ID", match[0], match.index));
  const labelled = matches(NATIONAL_ID_LABEL, text)
    .filter((match) => /\d/.test(match[1]) && !/[A-Za-z]{6,}/.test(match[1]))
    .map((match) => groupFinding("NATIONAL_ID", match));
  const wallets = matches(/\b0x[a-fA-F0-9]{40}\b/g, text)
    .map((match) => finding("ACCOUNT_NUMBER", match[0], match.index));
  return [...ssn, ...cnic, ...labelled, ...wallets];
}

/**
 * Technical-identifier findings. URLs come first so that a connection string
 * is redacted whole rather than as the e-mail-shaped `password@host` inside it.
 */
export function technicalFindings(text) {
  return [
    ...urlFindings(text),
    ...credentialFindings(text),
    ...cloudFindings(text),
    ...networkFindings(text),
    ...pathFindings(text),
    ...identityFindings(text),
  ];
}
