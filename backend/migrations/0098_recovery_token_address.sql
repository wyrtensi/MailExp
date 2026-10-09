-- The recovery address each sign-in code and password reset link was sent to. A code or link is
-- accepted only while the user's recovery_email is still that address, so one issued to the old
-- address while the user was changing it does not work from the old mailbox. Rows issued before
-- this column existed have no address and are refused; they expire within an hour anyway.
ALTER TABLE email_otp_tokens ADD COLUMN IF NOT EXISTS sent_to VARCHAR(255);
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS sent_to VARCHAR(255);

-- Reset links in the order they were issued, so a new link replaces only the ones issued before
-- it: two requests at once must not delete each other's links. created_at can tie.
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
