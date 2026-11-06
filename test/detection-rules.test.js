import assert from "node:assert/strict";
import test from "node:test";

import "../model-prompts.js";
import {
  filterModelEntities,
  isValidIpv4,
  passesLuhn,
  patternFindings,
  resolveFindings,
} from "../detection-rules.js";

const policy = globalThis.PrivyModelPrompts;
const found = (text) => patternFindings(text).map(({ type, value }) => [type, value]);

test("messages without personal data produce no pattern findings", () => {
  for (const text of [
    "I'm happy with the results, thanks!",
    "I am not sure this works.",
    "I'm working with arrays and maps in JavaScript.",
    "Release 2024-01-15 shipped version 10.2.3.4 with build 1234567890.",
    "Order number 123456789 has not arrived.",
    "The total was 1234567812345678 units.",
    "Call api_response_handler_function after login.",
    "Send a test to user@example.com.",
    "Bind the server to 127.0.0.1 or 0.0.0.0.",
  ]) {
    assert.deepEqual(found(text), [], text);
  }
});

test("contextual names require capitalization after I'm but not after my name is", () => {
  assert.deepEqual(found("Hi, I'm Momina and I need help"), [["PERSON", "Momina"]]);
  assert.deepEqual(found("i am Momina Babar."), [["PERSON", "Momina Babar"]]);
  assert.deepEqual(found("my name is momina"), [["PERSON", "momina"]]);
  assert.deepEqual(found("I'm José"), [["PERSON", "José"]]);
});

test("contextual organizations require a capitalized employer", () => {
  assert.deepEqual(found("I am working for UNICEF in Pakistan"), [["ORGANIZATION", "UNICEF"]]);
  assert.deepEqual(found("she works at home"), []);
});

test("phone numbers need phone formatting, an international prefix, or context", () => {
  assert.deepEqual(found("Call me at 0300 1234567"), [["PHONE", "0300 1234567"]]);
  assert.deepEqual(found("my number is 03001234567"), [["PHONE", "03001234567"]]);
  assert.deepEqual(found("+92 300 1234567"), [["PHONE", "+92 300 1234567"]]);
  assert.deepEqual(found("(555) 123-4567"), [["PHONE", "(555) 123-4567"]]);
});

test("identifiers at the end of a sentence are still detected", () => {
  assert.deepEqual(found("Call me on (415) 555-2938. Thanks"), [["PHONE", "(415) 555-2938"]]);
  assert.deepEqual(found("My number is +92 300 1234567."), [["PHONE", "+92 300 1234567"]]);
  assert.deepEqual(found("The host is 10.0.0.25."), [["IP_ADDRESS", "10.0.0.25"]]);
  assert.deepEqual(found("Version 1.2.3.4.5 shipped."), []);
});

test("employer names stop at the end of the sentence", () => {
  assert.deepEqual(found("I work at Initech Corp. You can reach me"), [["ORGANIZATION", "Initech Corp."]]);
  assert.deepEqual(found("I work at Acme Corp and love it"), [["ORGANIZATION", "Acme Corp"]]);
  assert.deepEqual(found("She works at Oxfam. Then she left"), [["ORGANIZATION", "Oxfam"]]);
  assert.deepEqual(found("I work for Johnson & Johnson. Great"), [["ORGANIZATION", "Johnson & Johnson"]]);
});

test("IPv4 detection rejects octets above 255", () => {
  assert.equal(isValidIpv4("192.168.1.20"), true);
  assert.equal(isValidIpv4("999.1.2.3"), false);
  assert.deepEqual(found("server 10.0.0.25 is down"), [["IP_ADDRESS", "10.0.0.25"]]);
  assert.deepEqual(found("server 300.0.0.25 is down"), []);
});

test("payment-card detection validates candidate numbers before redaction", () => {
  assert.equal(passesLuhn("4111111111111111"), true);
  assert.equal(passesLuhn("4111111111111112"), false);
  assert.deepEqual(found("card 4111 1111 1111 1111"), [["CREDIT_CARD", "4111 1111 1111 1111"]]);
});

test("private keys are redacted as a whole block, not just the header", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----";
  assert.deepEqual(found(`key:\n${key}\nthanks`), [["PRIVATE_KEY", key]]);
});

test("known secret formats and assigned passwords are detected", () => {
  assert.deepEqual(found("token ghp_" + "a1B2".repeat(9)), [["API_KEY", "ghp_" + "a1B2".repeat(9)]]);
  assert.deepEqual(found("password: hunter2!x"), [["SECRET", "hunter2!x"]]);
  assert.deepEqual(found("password: <your password>"), []);
});

test("dates of birth are detected only with birth context", () => {
  assert.deepEqual(found("DOB: 12/04/1990"), [["DATE_OF_BIRTH", "12/04/1990"]]);
  assert.deepEqual(found("born on 3rd of March, 1992"), [["DATE_OF_BIRTH", "3rd of March, 1992"]]);
  assert.deepEqual(found("The meeting is on 12/04/1990"), []);
});

const entity = (type, text, value, score = 0.99) => {
  const start = text.indexOf(value);
  return { type, value, score, start, end: start + value.length, source: "model" };
};

test("model findings drop MISC labels, fragments, lowercase noise, and code identifiers", () => {
  const text = "Use the evergreen English config in `UserService` hello";
  const kept = filterModelEntities([
    entity("MISC", text, "English"),
    entity("ORG", text, "ever"),
    entity("PER", text, "UserService"),
    entity("PER", text, "hello", 0.9),
  ], text, policy);
  assert.deepEqual(kept, []);
});

test("organizations and locations without personal context are weak", () => {
  const general = "Explain how Google ranks pages for users in Paris.";
  const weak = filterModelEntities([entity("ORG", general, "Google"), entity("LOC", general, "Paris")], general, policy);
  assert.deepEqual(weak.map((item) => item.weak), [true, true]);

  const personal = "I live in Lahore and Ali works at Acme Corp.";
  const strong = filterModelEntities([
    entity("LOC", personal, "Lahore"),
    entity("PER", personal, "Ali"),
    entity("ORG", personal, "Acme Corp"),
  ], personal, policy);
  assert.deepEqual(strong.map((item) => Boolean(item.weak)), [false, false, false]);
});

test("capitalized sentence-initial pronouns establish personal context", () => {
  const text = "My son attends Beaconhouse School in Islamabad. She lives in Springfield.";
  const findings = filterModelEntities([
    entity("ORG", text, "Beaconhouse School"),
    entity("LOC", text, "Islamabad"),
    entity("LOC", text, "Springfield"),
  ], text, policy);
  assert.deepEqual(findings.map((item) => Boolean(item.weak)), [false, false, false]);

  const country = "Flights to the US are expensive in Paris.";
  const travel = filterModelEntities([entity("LOC", country, "Paris")], country, policy);
  assert.equal(travel[0].weak, true);
});

test("every occurrence of a repeated value is kept for redaction", () => {
  const text = "Momina met Momina's sister";
  const findings = resolveFindings([entity("PER", text, "Momina"), {
    ...entity("PER", text, "Momina"), start: 11, end: 17,
  }]);
  assert.equal(findings.length, 2);
});

test("overlapping findings keep the earlier, higher-priority item", () => {
  const text = "mail momina@unicef.org";
  const findings = resolveFindings([
    ...patternFindings(text),
    entity("PER", text, "momina"),
  ]);
  assert.deepEqual(findings.map(({ type }) => type), ["EMAIL"]);
});

// Stand-in for a BERT vocabulary: common words are single tokens, names are not.
const VOCABULARY = new Set(["array", "home", "hours", "night", "weekend", "money", "living", "client", "government", "hospital", "start"]);
const withVocabulary = (text) => patternFindings(text, { isSingleToken: (word) => VOCABULARY.has(word) })
  .map(({ type, value }) => [type, value]);

test("lowercase employers are recognized when the vocabulary marks them as rare", () => {
  assert.deepEqual(withVocabulary("I am working for unicef in pakistan"), [["ORGANIZATION", "unicef"]]);
  assert.deepEqual(withVocabulary("she works at oxfam"), [["ORGANIZATION", "oxfam"]]);
  for (const text of [
    "working with arrays all day",
    "I work for hours at home",
    "I work at night and work for money",
    "working for clients and the government",
    "I worked for myself last year",
    "working for startups and nonprofits",
  ]) {
    assert.deepEqual(withVocabulary(text), [], text);
  }
});

test("without a vocabulary, lowercase employers are not guessed", () => {
  assert.deepEqual(found("I am working for unicef"), []);
});
