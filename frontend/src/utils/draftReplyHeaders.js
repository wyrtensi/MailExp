// Unfold MIME headers before restoring conversation metadata from a saved draft.
export function draftReplyHeaders(rawHeaders, message = {}, body = {}) {
  const headers = String(rawHeaders ?? '').replace(/\r?\n[ \t]+/g, ' ');
  const read = name => headers.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi'))?.[1]?.trim();
  return {
    inReplyTo: read('In-Reply-To') || body.inReplyTo || message.in_reply_to || undefined,
    references: read('References') || body.references || message.thread_references || undefined,
  };
}
