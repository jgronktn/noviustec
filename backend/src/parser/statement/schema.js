// JSON schema for the statement parser's structured output.
//
// Used with output_config.format on messages.create() — the Anthropic API
// enforces this shape. Constraints learned the hard way:
// - every object needs additionalProperties: false
// - no minimum / maximum / minLength etc (silently dropped at best, 400'd at worst)
// - nullables use anyOf: [{...}, {type: "null"}] — `type: ["string","null"]`
//   with an enum gets rejected ("Enum value X does not match declared type")
// - enums only inside the non-null branch of an anyOf, never alongside a
//   nullable type union.
//
// Two-tier shape: top-level metadata + a flat array of transaction lines.
// Amounts on lines are SIGNED — negative = charge/withdrawal/debit,
// positive = payment/deposit/credit. The model is told this in the prompt.

const nullable = (...schemas) => ({ anyOf: [...schemas, { type: "null" }] });

export const statementSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "confidence",
    "notes",
    "source",
    "period",
    "currency",
    "balances",
    "lines",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["parsed", "not_a_statement", "ambiguous"],
    },
    confidence: {
      type: "number",
      description:
        "Self-assessed confidence 0.0-1.0. Use < 0.5 when significant fields are guessed.",
    },
    notes: nullable({ type: "string" }),
    source: nullable({
      type: "object",
      additionalProperties: false,
      required: ["name", "last4", "institution", "kind"],
      properties: {
        name: nullable({ type: "string" }),
        last4: nullable({ type: "string" }),
        institution: nullable({ type: "string" }),
        kind: nullable({
          type: "string",
          enum: ["credit_card", "bank_account", "cash", "other"],
        }),
      },
    }),
    period: nullable({
      type: "object",
      additionalProperties: false,
      required: ["start", "end", "statement_date"],
      properties: {
        start: nullable({ type: "string" }), // YYYY-MM-DD
        end: nullable({ type: "string" }),
        statement_date: nullable({ type: "string" }), // close / issue date
      },
    }),
    currency: nullable({ type: "string" }), // ISO 4217
    balances: nullable({
      type: "object",
      additionalProperties: false,
      required: ["opening", "closing", "total_charges", "total_payments"],
      properties: {
        opening: nullable({ type: "number" }),
        closing: nullable({ type: "number" }),
        total_charges: nullable({ type: "number" }), // sum of charges as a POSITIVE number
        total_payments: nullable({ type: "number" }),
      },
    }),
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line_date", "description", "amount", "balance_after", "notes"],
        properties: {
          line_date: nullable({ type: "string" }), // YYYY-MM-DD if visible
          description: nullable({ type: "string" }),
          amount: { type: "number" }, // SIGNED — see prompt
          balance_after: nullable({ type: "number" }),
          notes: nullable({ type: "string" }),
        },
      },
    },
  },
};
