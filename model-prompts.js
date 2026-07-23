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
Treat people, organizations, locations, dates of birth, email addresses, phone
numbers, payment-card numbers, IP addresses, API keys, and private keys as
potentially sensitive. Prefer warning the user when confidence is high. Never
transmit the message, findings, or user feedback outside this device.
  `.trim(),

  minimumConfidence: 0.7,

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
