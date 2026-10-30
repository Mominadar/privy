/*
 * Labelled messages for the end-to-end model evaluation.
 *
 * `pii`     values that must be fully covered by findings that are redacted by
 *           default (non-weak). The type is the expected category; a finding of
 *           a different type still counts as redacted but is reported.
 * `notPii`  values that must not overlap any default-redacted finding.
 * `gap`     a short note when the case is a known limitation of the default
 *           model. Gap cases are reported but do not fail the suite, so the
 *           list doubles as a to-do for model or rule improvements. When a gap
 *           case starts passing, the suite says so and the note can be removed.
 *
 * Names are deliberately placed outside "my name is" / "I'm" so that the model,
 * not the regex fallback, is what gets tested.
 */
export const CASES = [
  // --- People --------------------------------------------------------------
  {
    name: "full name as email recipient",
    text: "Please draft an email to Sarah Johnson about the budget review.",
    pii: [["PERSON", "Sarah Johnson"]],
  },
  {
    name: "two South Asian names in one sentence",
    text: "Ayesha Khan and Bilal Ahmed are joining the field visit next week.",
    pii: [["PERSON", "Ayesha Khan"], ["PERSON", "Bilal Ahmed"]],
  },
  {
    name: "West African name with title",
    text: "Can you summarize the feedback that Dr. Oluwaseun Adeyemi gave on the report?",
    pii: [["PERSON", "Oluwaseun Adeyemi"]],
  },
  {
    name: "long South Indian surname",
    text: "My colleague Priya Raghunathan reviewed the draft yesterday.",
    pii: [["PERSON", "Priya Raghunathan"]],
  },
  {
    name: "accented multi-part Hispanic name",
    text: "Tell Juan Carlos Rodríguez that the meeting moved to Thursday.",
    pii: [["PERSON", "Juan Carlos Rodríguez"]],
  },
  {
    name: "single first name at sentence start",
    text: "Ahmed asked whether we can extend the deadline by a week.",
    pii: [["PERSON", "Ahmed"]],
  },
  {
    name: "name introduced with 'my name is' (regex path)",
    text: "Hi, my name is Momina Babar and I need help writing a cover letter.",
    pii: [["PERSON", "Momina Babar"]],
  },
  {
    name: "lowercase child's name",
    text: "my daughter fatima has had a fever since last night, what should i do?",
    pii: [["PERSON", "fatima"]],
    gap: "Cased BERT models rarely tag lowercase names.",
  },
  {
    name: "same name repeated",
    text: "Grace Mwangi submitted the form. Later, Grace Mwangi called to correct it.",
    pii: [["PERSON", "Grace Mwangi"], ["PERSON", "Grace Mwangi"]],
  },

  // --- Non-English ---------------------------------------------------------
  {
    name: "French name and home city",
    text: "Je m'appelle Camille Dubois et j'habite à Lyon avec ma famille.",
    pii: [["PERSON", "Camille Dubois"], ["LOCATION", "Lyon"]],
  },
  {
    name: "Spanish name",
    text: "Mi hermana Lucía Fernández necesita una cita con el médico.",
    pii: [["PERSON", "Lucía Fernández"]],
  },

  // --- Locations and organizations tied to a person -------------------------
  {
    name: "home city and employer",
    text: "I live in Lahore and work at UNICEF Pakistan.",
    pii: [["LOCATION", "Lahore"], ["ORGANIZATION", "UNICEF"]],
  },
  {
    name: "person, employer, and city",
    text: "Ali Raza works at Habib Bank in Karachi.",
    pii: [["PERSON", "Ali Raza"], ["ORGANIZATION", "Habib Bank"], ["LOCATION", "Karachi"]],
  },
  {
    name: "child's school and town",
    text: "My son attends Beaconhouse School in Islamabad.",
    pii: [["ORGANIZATION", "Beaconhouse School"], ["LOCATION", "Islamabad"]],
  },

  // --- Structured identifiers (pattern detectors, checked end to end) -------
  {
    name: "personal email",
    text: "Contact me at momina.babar@gmail.com if anything changes.",
    pii: [["EMAIL", "momina.babar@gmail.com"]],
  },
  {
    name: "international mobile number",
    text: "You can call me on +92 300 1234567 after 5pm.",
    pii: [["PHONE", "+92 300 1234567"]],
  },
  {
    name: "US phone number",
    text: "My number is (415) 555-0132, text before calling.",
    pii: [["PHONE", "(415) 555-0132"]],
  },
  {
    name: "date of birth",
    text: "My date of birth is 14/03/1992 and the form keeps rejecting it.",
    pii: [["DATE_OF_BIRTH", "14/03/1992"]],
  },
  {
    name: "payment card",
    text: "My card number is 4111 1111 1111 1111, why was it declined?",
    pii: [["CREDIT_CARD", "4111 1111 1111 1111"]],
  },
  {
    name: "IBAN",
    text: "Please send the refund to GB82 WEST 1234 5698 7654 32.",
    pii: [["ACCOUNT_NUMBER", "GB82 WEST 1234 5698 7654 32"]],
  },
  {
    name: "API key",
    text: "Why does sk-proj-AbCdEf1234567890GhIjKlMn return 401?",
    pii: [["API_KEY", "sk-proj-AbCdEf1234567890GhIjKlMn"]],
  },
  {
    name: "case-management record",
    text: "Beneficiary: Maria Garcia, DOB 1987-06-21, phone +1 555 201 3344, " +
      "email maria.garcia@outlook.com. She lives in Springfield with two children.",
    pii: [
      ["PERSON", "Maria Garcia"],
      ["DATE_OF_BIRTH", "1987-06-21"],
      ["PHONE", "+1 555 201 3344"],
      ["EMAIL", "maria.garcia@outlook.com"],
      ["LOCATION", "Springfield"],
    ],
  },
  {
    name: "name beyond the first chunk",
    text: `${"The quarterly report covers programme delivery, supply chain metrics, and staffing. ".repeat(12)}` +
      "Questions should go to Tomasz Kowalczyk.",
    pii: [["PERSON", "Tomasz Kowalczyk"]],
  },

  // --- Look-alikes that must not be redacted --------------------------------
  {
    name: "geography question",
    text: "What is the capital of France? Is Paris bigger than Berlin?",
    notPii: ["France", "Paris", "Berlin"],
  },
  {
    name: "company comparison",
    text: "Compare Microsoft and Google cloud pricing for a small team.",
    notPii: ["Microsoft", "Google"],
  },
  {
    name: "software products",
    text: "I use Chrome on Windows and the extension crashes on startup.",
    notPii: ["Chrome", "Windows"],
  },
  {
    name: "programming language",
    text: "Explain how Python's asyncio event loop schedules coroutines.",
    notPii: ["Python", "asyncio"],
  },
  {
    name: "identifiers inside code",
    text: "Why does `const userName = getUser(accountId)` return undefined?",
    notPii: ["userName", "getUser", "accountId"],
  },
  {
    name: "version numbers and loopback address",
    text: "After upgrading from 2.10.3 to 3.0.1 the server on 127.0.0.1 stopped responding.",
    notPii: ["2.10.3", "3.0.1", "127.0.0.1"],
  },
  {
    name: "meeting date and order number",
    text: "The meeting is on 2024-05-12. Order number 1234567890 has not arrived.",
    notPii: ["2024-05-12", "1234567890"],
  },
  {
    name: "greeting and sign-off",
    text: "Hello! Thanks for the help earlier. Cheers.",
    notPii: ["Hello", "Thanks", "Cheers"],
  },
  {
    name: "reserved example email",
    text: "Use test@example.com as the placeholder in the docs.",
    notPii: ["test@example.com"],
  },
  {
    name: "medical dosage",
    text: "The guideline says 500 mg twice a day for children over 12.",
    notPii: ["500", "12"],
  },
];
