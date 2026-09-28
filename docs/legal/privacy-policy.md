# MailExpert Privacy Policy

Last updated: 28 September 2026

MailExpert is self-hosted software: a web panel through which a team works with shared mailboxes
(Gmail and mailboxes on the team's own domains). Each installation is run by its operator, the
organisation that installed it, on the operator's own server. The operator decides who may sign in
and which mailboxes are connected, and is responsible for the data the installation holds. The
MailExpert project does not run a hosted service and receives no data from installations.

## Data the panel accesses

When a Gmail mailbox is connected, Google asks its owner to grant the panel access to Gmail
(`https://mail.google.com/`) and to the mailbox's email address. With this access the panel:

- reads the mailbox over IMAP to show its folders and letters to the signed-in team members;
- sends mail over SMTP when a team member sends or replies from that mailbox;
- moves, flags and deletes letters when a team member asks for it.

The panel stores, in the operator's database on the operator's server: the OAuth tokens
(encrypted), a copy of letters' headers and text for the list and search, the actions taken on the
mailbox and by whom (an audit log), and settings.

## How the data is used and shared

Data from Google APIs is used only to provide the mailbox features described above to the team
members the operator allows to sign in. It is not sold, not used for advertising, not used to
train AI or machine-learning models, and not transferred to anyone else, except:

- when a team member uses an optional feature the operator has turned on, and only the data that
  feature needs: an AI assistant sends the text the member chose to the AI provider the operator
  configured; sender icons send the sender's domain to an icon service; contact pictures send a
  hash of the address to Gravatar; a task integration sends the task the member created;
- when the law requires it.

MailExpert's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Retention and deletion

Letters stay in the mailbox itself. When a mailbox is removed from the panel, its tokens and the
panel's copy of its letters are deleted, and — for a Gmail mailbox — the panel also revokes its
own access to that Google account, the same access a mailbox owner can otherwise revoke at any
time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
The audit log is kept as long as the operator's policy requires.

## Security

Tokens and mailbox passwords are stored encrypted; the panel is reached over HTTPS only and only
by users the operator approved.

## Contact

Questions about an installation go to its operator. Questions about the software:
wyrtensi@gmail.com.
