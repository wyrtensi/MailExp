import express from 'express';

// The JSON body limit of the composer's requests (/api/mail/send, /api/mail/draft). Attachments
// travel as base64: the 25 MB attachment cap is ~33.4 MB on the wire, forwarded attachments
// included once an undone or edited letter gives them back with their bytes, plus the body and its
// quoted HTML. Kept under the 50m client_max_body_size of the bundled nginx configs.
export const COMPOSE_JSON_LIMIT = '45mb';

export const composeJson = () => express.json({ limit: COMPOSE_JSON_LIMIT });
