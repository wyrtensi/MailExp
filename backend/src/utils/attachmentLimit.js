// The cap on a letter's total attachment bytes: 25 MiB (26 214 400 bytes), in binary units.
// Every message that names the cap says MiB, so a file between 25 000 000 and 26 214 400 bytes
// is not refused by a hint while the check itself accepts it.
export const MAX_ATTACHMENT_BYTES = 26_214_400;
export const ATTACHMENT_LIMIT_ERROR = 'Total attachment size exceeds 25 MiB';
