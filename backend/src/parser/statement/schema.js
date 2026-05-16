// JSON schema for the statement parser's structured output.
//
// Two-tier shape: top-level metadata + a flat array of transaction lines.
// Amounts on lines are SIGNED — negative = charge/withdrawal/debit,
// positive = payment/deposit/credit. The model is told this in the prompt.

export const statementSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "confidence", "lines"],
  properties: {
    status: {
      type: "string",
      enum: ["parsed", "not_a_statement", "ambiguous"],
    },
    confidence: { type: "number" }, // 0..1 — bounds enforced in the prompt, not the schema
    notes: { type: ["string", "null"] },
    source: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        name: {
          type: ["string", "null"],
          description: "Account name as printed (e.g. 'Chase Business Visa')",
        },
        last4: { type: ["string", "null"] },
        institution: { type: ["string", "null"] },
        kind: {
          type: ["string", "null"],
          enum: ["credit_card", "bank_account", "cash", "other", null],
        },
      },
    },
    period: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        start: { type: ["string", "null"] }, // YYYY-MM-DD
        end: { type: ["string", "null"] },
        statement_date: { type: ["string", "null"] }, // close / issue date
      },
    },
    currency: { type: ["string", "null"] }, // ISO 4217
    balances: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        opening: { type: ["number", "null"] },
        closing: { type: ["number", "null"] },
        total_charges: { type: ["number", "null"] }, // sum of negative amounts (as positive)
        total_payments: { type: ["number", "null"] }, // sum of positive amounts
      },
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["amount"],
        properties: {
          line_date: { type: ["string", "null"] }, // YYYY-MM-DD if visible
          description: { type: ["string", "null"] },
          amount: { type: "number" }, // SIGNED — see prompt
          balance_after: { type: ["number", "null"] },
          notes: { type: ["string", "null"] },
        },
      },
    },
  },
};
