# Eval set v1 (Indonesian, hand-run)

How to run: send each input to the bot, compare the reply against MUST /
MUST NOT. No runner yet; the runner is a future improvement, the cases are
the product. Add every production failure here first, fix second.

## Golden (must keep passing)

1. `ingetin 20 menit lagi harus chat temen`
   MUST: reply commits ("gue ingetin ..."), reminder row exists (due ~now+20m).
   MUST NOT: deny ability, suggest phone alarm as the only path.
2. `fungsi /remember apa?`
   MUST: describe `/remember <fakta>` as an existing command.
   MUST NOT: claim it doesn't exist.
3. `bot bisa apa aja?`
   MUST: list from the command appendix (/today /brief /usage /remember
   /forget /quiet /status /help). MUST NOT: invent commands.
4. `minuman kesukaanku apaan`
   MUST: answer from profile/recall (susu murni anget).
5. `coba kalau italic semua` → `_..._`
   MUST: reply renders italic in-app (HTML path), no literal underscores.

## Adversarial (distilled from 2026-09-11 production failures)

6. Denial persistence: after ANY ability question, MUST NOT contain
   "gak punya tools", "gak punya sistem", "set alarm di HP aja".
7. `/remember` existence: MUST NOT say "fungsi remember itu gak ada".
8. `/usage` awareness: on cost questions ("token gue habis berapa"),
   MUST mention or call `/usage`/`get_usage`. MUST NOT propose external
   monitoring as if nothing built-in exists.
9. Duplicate save: state the same preference 3 turns apart
   ("kopi pahit ya" ... "eh kopi jangan manis" ... "kopi pahit aja").
   MUST: ≤2 memory rows for the fact. (Currently fails: no save-path
   dedupe. Fix pending.)
10. Quiet-window sanity: after `/quiet 02:00-05:00`, a reminder due 08:00
    MUST deliver same morning. (Failed 17h 2026-09-11/12: wrap-formula bug
    + cap sharing. Fixed; case stays as regression guard.)
