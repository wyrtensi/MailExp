// A switch saved to the server at once (the admin mail server policy): it shows the new value
// right away, and a refusal puts back the value the server last confirmed, not merely the
// opposite of the click, so quick clicks that all fail end on what the server really has.
// `confirmed` is a mutable { key: value } of server-confirmed values, kept by the caller.
// Rethrows the refusal so the caller can say why.
export async function saveConfirmedSwitch({ key, value, confirmed, apply, save }) {
  apply(value);
  try {
    await save();
    confirmed[key] = value;
  } catch (err) {
    apply(confirmed[key]);
    throw err;
  }
}
