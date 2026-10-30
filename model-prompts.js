/*
 * Human-editable local detection policy.
 *
 * These BERT models are token-classification models, not generative LLMs, so
 * they do not accept a natural-language system prompt. This text documents the
 * intended behavior, while the threshold and placeholders below directly
 * control local post-processing and redaction.
 */
globalThis.PrivyModelPrompts = Object.freeze({
  policyText: `
Detect personally identifiable information in an outgoing message.
Treat people, dates of birth, email addresses, phone numbers, payment-card
and bank account numbers, IP addresses, API keys, passwords, and private keys
as sensitive. Treat organizations and locations as sensitive only when the
message ties them to a person. Ignore identifiers inside code, version
numbers, dates, and other look-alikes. Prefer warning the user when confidence
is high. Never transmit the message, findings, mappings, or user feedback
outside this device.
  `.trim(),

  minimumConfidence: 0.7,

  // Per-type minimum model confidence. Organizations and locations are the
  // most common false positives (product names, public places), so they need
  // stronger evidence than names.
  typeThresholds: Object.freeze({
    PER: 0.8,
    PERSON: 0.8,
    ORG: 0.85,
    ORGANIZATION: 0.85,
    LOC: 0.85,
    LOCATION: 0.85,
  }),

  // These types are only treated as private when the same sentence ties them
  // to a person ("I live in Lahore", "Ali works at UNICEF"). Without that
  // context they are still listed in the confirmation dialog, unselected, but
  // they do not interrupt sending on their own.
  contextRequiredTypes: Object.freeze(["ORG", "ORGANIZATION", "LOC", "LOCATION"]),

  placeholders: Object.freeze({
    PER: "[PERSON]",
    PERSON: "[PERSON]",
    ORG: "[ORGANIZATION]",
    ORGANIZATION: "[ORGANIZATION]",
    LOC: "[LOCATION]",
    LOCATION: "[LOCATION]",
    EMAIL: "[EMAIL]",
    PHONE: "[PHONE]",
    DATE_OF_BIRTH: "[DATE_OF_BIRTH]",
    CREDIT_CARD: "[PAYMENT_CARD]",
    IP_ADDRESS: "[IP_ADDRESS]",
    API_KEY: "[API_KEY]",
    PRIVATE_KEY: "[PRIVATE_KEY]",
    PRIVATE_ADDRESS: "[PRIVATE_ADDRESS]",
    PRIVATE_URL: "[PRIVATE_URL]",
    ACCOUNT_NUMBER: "[ACCOUNT_NUMBER]",
    SECRET: "[SECRET]",
    PRIVATE_ENTITY: "[PRIVATE_INFORMATION]",
  }),
});
