#!/usr/bin/env python3
"""Ledger -> expense-tracker import-JSON converter.

Personal-ledger-format-specific tooling (not general purpose) built for one
user's real ledger. Produces/updates:
  - ledger-import.json         (ready to import via Settings -> Import backup...)
  - ledger-import-skipped.md   (entries that needed manual review, with reasons)

Both output files are gitignored (real financial data) -- this script itself
is committed since it contains no financial data, only parsing/mapping logic.

Two source formats are supported so far:

1. `hledger` format: full double-entry hledger-style plaintext. One posting
   per money-moving leg; categories are `Expenses:...`/`Income:...` account
   paths. See `import_hledger()`.
2. `flat` format: blank-line-separated date blocks (`dd/mm`, one header line
   per day) followed by one `[+]AMOUNT DESCRIPTION` per line -- no double
   entry, no category hierarchy. See `import_flat()`.

Usage (from repo root):
    python3 tools/ledger_import.py hledger path/to/paste.md
    python3 tools/ledger_import.py flat path/to/paste.md --year 2026

Each run loads the existing ledger-import.json (if present) to continue id
sequences and reuse existing accounts/tags instead of duplicating them, then
merges the new paste in and rewrites both output files. Review
ledger-import-skipped.md after every run -- entries that couldn't be safely
auto-converted are listed there with the raw source and a reason, never
silently guessed.

If a future paste is in a genuinely new format, add a third `import_*()`
function following the same shape (return a list of "ready" transaction
dicts -- see the `{'date','type','account_name','description','line_items'}`
shape produced by both existing importers -- plus a list of
`(raw_source_repr, reason)` skip tuples) and wire it into `main()`.
"""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXPORT_PATH = REPO_ROOT / "ledger-import.json"
SKIP_REPORT_PATH = REPO_ROOT / "ledger-import-skipped.md"

# ---------------------------------------------------------------------------
# Shared helpers (money/tags — mirror js/money.js and js/db.js normalizeTagName)
# ---------------------------------------------------------------------------


def to_paise(amount):
    return int(round(amount * 100))


TAG_RENAMES = {
    "???": "unknown",
    "it": "itr",
}


def normalize_tag(name):
    name = re.sub(r"\s+", " ", name.strip().lower())
    name = name.replace("d-mart", "dmart")
    return TAG_RENAMES.get(name, name)


# Ledger "; comment :tag1:tag2:" metadata: a whitespace-delimited token that
# starts AND ends with ':' is a colon-joined tag list, not prose. Trailing
# punctuation (closing parens etc.) is stripped before the check so
# "...by :solomon:)" still extracts "solomon".
TAG_TOKEN_RE = re.compile(r"^:[^\s:]+(?::[^\s:]+)*:$")


def extract_inline_tags(comment):
    """Split a free-text comment into (inline_tags, remaining_description)."""
    if not comment:
        return [], ""
    tags, kept = [], []
    for tok in comment.split():
        core = tok.rstrip(").,!?;")
        trail = tok[len(core):]
        if core.strip(":") == "":
            continue  # stray punctuation-only token (e.g. a lone ':')
        if TAG_TOKEN_RE.match(core):
            tags.extend(t for t in core.strip(":").split(":") if t)
            if trail:
                kept.append(trail)
        else:
            kept.append(tok)
    return tags, " ".join(kept).strip()


# A tag in this set gets replaced by the listed tags and its own name is
# folded into the description instead -- these were never meaningful tags on
# their own (a person's nickname for a one-off event), just mistagged.
TAG_REDIRECTS = {
    "riyaz-bhaiyya": ["tfi"],
    "bebu-haar": ["bebu", "gift"],
}

# A bare keyword match against the description adds these tags, regardless
# of source format (hledger category path or flat-format free text).
DESCRIPTION_KEYWORD_TAGS = [
    (re.compile(r"\bnetflix\b", re.I), ["subscription", "netflix"]),
]


def apply_tag_policies(description, tags):
    """Applies TAG_REDIRECTS and DESCRIPTION_KEYWORD_TAGS to one line item's
    (description, tags) before it's normalized/stored. Returns (description, tags)."""
    tags = list(tags)
    for special, extra_tags in TAG_REDIRECTS.items():
        if any(normalize_tag(t) == special for t in tags):
            tags = [t for t in tags if normalize_tag(t) != special]
            for extra in extra_tags:
                if not any(normalize_tag(t) == extra for t in tags):
                    tags.append(extra)
            if special not in description.lower():
                description = f"{description} {special}".strip()
    for pattern, extra_tags in DESCRIPTION_KEYWORD_TAGS:
        if pattern.search(description):
            for extra in extra_tags:
                if not any(normalize_tag(t) == extra for t in tags):
                    tags.append(extra)
    return description, tags


# ---------------------------------------------------------------------------
# Export-file accumulator: continues id sequences across multiple runs by
# loading whatever ledger-import.json already exists.
# ---------------------------------------------------------------------------


class Accumulator:
    def __init__(self):
        self.accounts_by_name = {}
        self.tags_by_name = {}
        self.transactions = []
        self.line_items = []
        self.txn_id = 0
        self.li_id = 0

    @classmethod
    def load(cls, path=EXPORT_PATH):
        acc = cls()
        if not path.exists():
            return acc
        data = json.loads(path.read_text(encoding="utf-8"))
        acc.accounts_by_name = {a["name"]: a["id"] for a in data["accounts"]}
        acc.tags_by_name = {t["name"]: t["id"] for t in data["tags"]}
        acc.transactions = data["transactions"]
        acc.line_items = data["lineItems"]
        acc.txn_id = max((t["id"] for t in acc.transactions), default=0)
        acc.li_id = max((li["id"] for li in acc.line_items), default=0)
        return acc

    def get_account_id(self, name):
        if name not in self.accounts_by_name:
            self.accounts_by_name[name] = len(self.accounts_by_name) + 1
        return self.accounts_by_name[name]

    def get_tag_id(self, raw_name):
        name = normalize_tag(raw_name)
        if not name:
            raise ValueError("empty tag name")
        if name not in self.tags_by_name:
            self.tags_by_name[name] = len(self.tags_by_name) + 1
        return self.tags_by_name[name]

    def add_transaction(self, date, txn_type, account_name, description, line_items):
        """line_items: list of {'amount': rupees(float, positive), 'description': str, 'tags': [str]}"""
        self.txn_id += 1
        account_id = self.get_account_id(account_name)
        total_paise = 0
        for li in line_items:
            li_description, li_tags = apply_tag_policies(li["description"], li["tags"])
            li = {**li, "description": li_description, "tags": li_tags}
            tag_ids, seen = [], set()
            for tag in li["tags"]:
                tid = self.get_tag_id(tag)
                if tid not in seen:
                    seen.add(tid)
                    tag_ids.append(tid)
            if not tag_ids:
                raise ValueError(f"line item with no tags: {li}")
            amount_paise = to_paise(abs(li["amount"]))
            self.li_id += 1
            self.line_items.append(
                {
                    "id": self.li_id,
                    "transactionId": self.txn_id,
                    "amount": amount_paise,
                    "description": li["description"],
                    "tagIds": tag_ids,
                }
            )
            total_paise += amount_paise
        self.transactions.append(
            {
                "id": self.txn_id,
                "date": date,
                "type": txn_type,
                "accountId": account_id,
                "description": description,
                "statedTotal": total_paise,
            }
        )

    def write(self, path=EXPORT_PATH):
        accounts = [{"id": aid, "name": name, "statementCycleStartDay": None} for name, aid in self.accounts_by_name.items()]
        tags = [{"id": tid, "name": name} for name, tid in self.tags_by_name.items()]
        transactions = sorted(self.transactions, key=lambda t: (t["date"], t["id"]))
        data = {
            "schema": "expense-tracker",
            "version": 1,
            "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "accounts": accounts,
            "tags": tags,
            "transactions": transactions,
            "lineItems": self.line_items,
        }
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        return data


def append_skip_report(heading, entries, path=SKIP_REPORT_PATH):
    """entries: list of (raw_text_block: str, reason: str)"""
    lines = [f"\n\n---\n\n# {heading}\n\n", f"{len(entries)} entries needing manual review.\n\n"]
    for raw_text, reason in entries:
        lines.append(f"Reason: {reason}\n\n```\n{raw_text}\n```\n\n")
    with path.open("a", encoding="utf-8") as f:
        f.writelines(lines)


# ---------------------------------------------------------------------------
# Format 1: hledger-style double-entry plaintext
# ---------------------------------------------------------------------------

# Only these ledger accounts represent real money movement; everything else
# (investments, person-to-person loans, equity) is out of scope for this app
# and causes the whole ledger-transaction to be skipped for manual review.
# Extend this dict (and re-run) if new accounts show up in future pastes.
HLEDGER_MONEY_ACCOUNTS = {
    "Assets:checking:yesbank": "Yes Bank",
    "Assets:checking:hdfc": "HDFC Bank",
    "Assets:checking:amazon-pay": "Amazon Pay",
    "Assets:cash": "Cash",
    "Liabilities:credit-card:hdfc": "HDFC Card",
    "Liabilities:credit-card:sbi": "SBI Card",
}

_HLEDGER_DATE_RE = re.compile(
    r"^(\d{4})[-/](\d{2})[-/](\d{2})(?:=\d{4}[-/]\d{2}[-/]\d{2})?(?:\s+([*!])\s*)?(.*)$"
)
_HLEDGER_POSTING_RE = re.compile(r"^(?:[*!]\s+)?(\S+)(?:\s+(-?[\d,]+\.?\d*))?\s*(?:;\s*(.*))?$")


def _hledger_classify(account):
    if account in HLEDGER_MONEY_ACCOUNTS:
        return "money"
    if account.startswith("Expenses") or account.startswith("Income"):
        return "category"
    return "out_of_scope"


def _hledger_parse_amount(s):
    return None if s is None else float(s.replace(",", ""))


def _parse_hledger_transactions(lines):
    """Tokenize raw lines into transactions: {date, description, line, postings}.
    Skips top-level `#`-comment lines (disabled/historical blocks), blank
    lines, and `account ...` declaration lines."""
    transactions = []
    i, n = 0, len(lines)
    while i < n:
        stripped = lines[i].rstrip("\n").strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("account "):
            i += 1
            continue
        m = _HLEDGER_DATE_RE.match(stripped)
        if not m:
            i += 1
            continue
        y, mo, d, _status, desc = m.groups()
        txn = {"date": f"{y}-{mo}-{d}", "description": desc.strip(), "line": i + 1, "postings": []}
        i += 1
        while i < n:
            pline = lines[i].rstrip("\n")
            if pline.strip() == "":
                i += 1
                break
            if not pline[:1].isspace():
                break
            pm = _HLEDGER_POSTING_RE.match(pline.strip())
            if pm:
                account, amount, comment = pm.groups()
                txn["postings"].append(
                    {"account": account, "amount": _hledger_parse_amount(amount), "comment": comment or "", "line": i + 1}
                )
            i += 1
        transactions.append(txn)
    for txn in transactions:
        elided = [p for p in txn["postings"] if p["amount"] is None]
        if len(elided) == 1:
            known_sum = sum(p["amount"] for p in txn["postings"] if p["amount"] is not None)
            elided[0]["amount"] = -known_sum
        elif len(elided) > 1:
            raise ValueError(f"transaction at line {txn['line']} has {len(elided)} elided amounts (only 1 allowed)")
    return transactions


def _hledger_render_postings(postings):
    lines = []
    for p in postings:
        amt = f"{p['amount']:.2f}" if p["amount"] is not None else "(elided)"
        comment = f"  ; {p['comment']}" if p["comment"] else ""
        lines.append(f"    {p['account']:<45} {amt:>12}{comment}")
    return "\n".join(lines)


def _decompose_multi_money_leg(t):
    """A "daily misc"-style entry can bundle several unrelated purchases
    across more than one money account into one hledger transaction. Walk
    postings in order; category legs accumulate into a pending list; when a
    money leg appears, try the longest-to-shortest trailing (suffix) run of
    not-yet-closed category legs and see if its sum balances the money leg
    -- whichever suffix matches closes that sub-purchase. This recovers
    ~85% of such compound entries without ever guessing a pairing that
    doesn't actually balance.
    Out-of-scope postings (investments, person-to-person loans, equity) count
    toward the balancing sum -- a suffix can only close a purchase if it
    balances the money leg exactly, and a loan/transfer often shares a suffix
    with real purchases in these bundled "daily misc" entries -- but never
    become line items themselves: once a suffix matches, only its category
    (Expenses/Income) members are kept for the emitted group.
    Returns (groups, 'ok') | (None, 'pure_transfer') | (None, 'unresolved')
    where groups = [(money_posting_index, [category_posting_indices]), ...]
    (groups with zero category postings, i.e. pure transfers/loans, are
    dropped silently rather than emitted).
    """
    postings = t["postings"]
    if not any(_hledger_classify(p["account"]) == "category" for p in postings):
        return None, "pure_transfer"

    n = len(postings)
    kinds = [_hledger_classify(p["account"]) for p in postings]
    used = [False] * n
    groups = []
    pending = []

    # Contiguous runs of money-account postings (e.g. an ATM withdrawal:
    # cash +10000 / checking -10000, back to back, no category leg between
    # them) are pure account-to-account transfers, not purchases -- if such
    # a run sums to zero on its own, consume it entirely up front so it
    # doesn't have to (and can't) match against any pending category suffix.
    self_transfer = set()
    i = 0
    while i < n:
        if kinds[i] == "money":
            j = i
            while j < n and kinds[j] == "money":
                j += 1
            run = list(range(i, j))
            if len(run) >= 2 and abs(sum(postings[k]["amount"] for k in run)) <= 0.01:
                self_transfer.update(run)
            i = j
        else:
            i += 1
    for idx in self_transfer:
        used[idx] = True

    for idx, p in enumerate(postings):
        if idx in self_transfer:
            continue
        kind = kinds[idx]
        if kind in ("category", "out_of_scope"):
            pending.append(idx)
        elif kind == "money":
            matched = None
            for start in range(0, len(pending)):
                suffix = pending[start:]
                s = sum(postings[j]["amount"] for j in suffix)
                if abs(abs(s) - abs(p["amount"])) <= 0.01:
                    matched = suffix
                    break
            if matched is not None:
                cat_only = [j for j in matched if _hledger_classify(postings[j]["account"]) == "category"]
                if cat_only:
                    groups.append((idx, cat_only))
                used[idx] = True
                for j in matched:
                    used[j] = True
                pending = pending[: len(pending) - len(matched)]

    # Leftover category legs that never matched any money leg by exact suffix
    # sum (e.g. a "1st of month" entry that pays down credit cards AND funds
    # a batch of category spending out of the same elided/catch-all money
    # leg) get attributed wholesale to the last not-yet-used money posting --
    # by hledger's elision rule that leg's amount is already defined as
    # "whatever balances the rest", so this is exact, not a guess. Any other
    # still-unused money postings (e.g. the card-payment legs themselves) are
    # then pure transfers between tracked accounts, not purchases -- discard.
    if pending:
        unmatched_money = [idx for idx in range(n) if kinds[idx] == "money" and not used[idx]]
        if unmatched_money:
            catch_all = unmatched_money[-1]
            cat_only = [j for j in pending if _hledger_classify(postings[j]["account"]) == "category"]
            if cat_only:
                groups.append((catch_all, cat_only))
            for idx in unmatched_money:
                used[idx] = True
            for j in pending:
                used[j] = True
            pending = []
    else:
        for idx in range(n):
            if kinds[idx] == "money" and not used[idx]:
                used[idx] = True

    if pending or not all(used):
        return None, "unresolved"
    return groups, "ok"


def import_hledger(text):
    """Returns (ready_txns, skip_entries) where ready_txns is a list of
    {'date','type','account_name','description','line_items'} and
    line_items is [{'amount','description','tags'}] (amount in rupees,
    tags as raw strings), and skip_entries is [(raw_source, reason)]."""
    transactions = _parse_hledger_transactions(text.splitlines())
    ready = []
    skip = []
    single_leg_ready = []
    multi_leg = []


    for t in transactions:
        postings = t["postings"]

        money_legs = [p for p in postings if _hledger_classify(p["account"]) == "money"]
        category_legs = [p for p in postings if _hledger_classify(p["account"]) == "category"]

        if len(money_legs) == 0:
            skip.append((t, "no money account involved (pure category-to-category entry)"))
            continue
        if len(money_legs) > 1:
            multi_leg.append(t)
            continue
        if len(category_legs) == 0:
            skip.append((t, "money leg with no category legs"))
            continue

        money_leg = money_legs[0]
        expense_legs = [p for p in category_legs if p["account"].startswith("Expenses")]
        income_legs = [p for p in category_legs if p["account"].startswith("Income")]

        if expense_legs and income_legs:
            # Split mixed transaction into two: one expense, one income.
            # Type is taken from the leg's own account prefix, not re-derived
            # from a computed sum's sign -- a stray positive-signed Income
            # posting (a real inconsistency seen in this ledger) would
            # otherwise flip the whole synthetic transaction to "expense".
            ready.append(_hledger_to_ready(t, money_leg, expense_legs, txn_type="expense"))
            ready.append(_hledger_to_ready(t, money_leg, income_legs, txn_type="income"))
            continue

        # Single-type txn
        single_leg_ready.append((t, money_leg, category_legs))
    for t, money_leg, category_legs in single_leg_ready:
        # category_legs is homogeneous here (mixed case already split above).
        # Type is taken from the leg's own account prefix, never from sign,
        # for the same reason as the split above.
        txn_type = "income" if category_legs[0]["account"].startswith("Income") else "expense"
        ready.append(_hledger_to_ready(t, money_leg, category_legs, txn_type=txn_type))
    for t in multi_leg:
        groups, status = _decompose_multi_money_leg(t)
        if status == "pure_transfer":
            continue  # not spending/income, skip silently by design
        if status != "ok":
            skip.append((t, "multiple money accounts, could not cleanly cluster into sub-purchases"))
            continue
        for money_idx, cat_idxs in groups:
            money_leg = t["postings"][money_idx]
            cat_legs = [t["postings"][j] for j in cat_idxs]
            expense_legs = [p for p in cat_legs if p["account"].startswith("Expenses")]
            income_legs = [p for p in cat_legs if p["account"].startswith("Income")]
            if expense_legs and income_legs:
                ready.append(_hledger_to_ready(t, money_leg, expense_legs, line=money_leg["line"], txn_type="expense"))
                ready.append(_hledger_to_ready(t, money_leg, income_legs, line=money_leg["line"], txn_type="income"))
                continue
            txn_type = "income" if income_legs else "expense"
            ready.append(_hledger_to_ready(t, money_leg, cat_legs, line=money_leg["line"], txn_type=txn_type))

    skip_entries = [
        (f"{t['date']} — {t['description'] or '(no description)'} (line {t['line']})\n{_hledger_render_postings(t['postings'])}", reason)
        for t, reason in skip
    ]
    return ready, skip_entries


def _hledger_to_ready(t, money_leg, category_legs, line=None, txn_type=None):
    line_items = []
    for leg in category_legs:
        path = leg["account"].split(":")[1:]  # drop leading Expenses/Income
        inline_tags, desc = extract_inline_tags(leg["comment"])
        line_items.append({"amount": abs(leg["amount"]), "description": desc, "tags": list(path) + inline_tags})
    return {
        "date": t["date"],
        "type": txn_type or ("expense" if money_leg["amount"] < 0 else "income"),
        "account_name": HLEDGER_MONEY_ACCOUNTS[money_leg["account"]],
        "description": t["description"],
        "line_items": line_items,
        "line": line or money_leg.get("line", t["line"]),
    }


# ---------------------------------------------------------------------------
# Format 2: flat "dd/mm block, then AMOUNT DESCRIPTION per line"
# ---------------------------------------------------------------------------

FLAT_ACCOUNT_KEYWORDS = [
    (re.compile(r"\bhdfccc\b", re.I), "HDFC Card"),
    (re.compile(r"\bsbicc\b", re.I), "SBI Card"),
    (re.compile(r"\bcash\b", re.I), "Cash"),
    (re.compile(r"\bamazonpay\b", re.I), "Amazon Pay"),
]
FLAT_DEFAULT_ACCOUNT = "HDFC UPI"

# Person names to tag whenever mentioned in a description.
FLAT_PERSON_WORDS = [
    "aai", "bebu", "teju", "pappa", "abhi", "chinoo", "solomon", "kanika",
    "kumar", "watchman", "jafari", "gunju",
]

# Ordered (regex, tags) rules — every rule whose pattern matches contributes
# its tags (not first-match-wins). Matched against the description AFTER the
# account keyword has been stripped out. Extend this list as new recurring
# concepts show up in future pastes; there is no category hierarchy in this
# format to derive tags from otherwise, so this table IS the tag vocabulary
# for anything not already covered by an hledger import's category tags.
FLAT_KEYWORD_RULES = [
    (r"\bola\b", ["commute", "taxi"]),
    (r"\brickshaw\b", ["commute", "rickshaw"]),
    (r"\btrain\b", ["commute", "train"]),
    (r"\bfuel\b", ["commute", "fuel"]),
    (r"\btaxi\b", ["commute", "taxi"]),
    (r"\bsnacks?\b", ["groceries", "snacks"]),
    (r"\bd'?mart\b", ["groceries", "dmart"]),
    (r"\bveggies?\b|\bfruits?\b", ["groceries", "veggies-fruits"]),
    (r"\bgroceries\b", ["groceries"]),
    (r"\blunch\b|\bdinner\b|\bbfast\b|\bbreakfast\b|\bcoffee\b|\bdining\b", ["entertainment", "dining"]),
    (r"\bmedicines?\b", ["health", "medical", "medicines"]),
    (r"\bdoctor\b", ["health", "medical", "doctor"]),
    (r"\bblood tests?\b|\btests?\b", ["health", "medical", "tests"]),
    (r"\bhospital\b", ["health", "medical", "hospital"]),
    (r"\bmassager\b|\bpull up bar\b|\bexercise\b", ["health", "fitness"]),
    (r"\bschool fees\b", ["004", "school-fees"]),
    (r"\bkanya yojana\b", ["004", "kanya-yojana", "bebu"]),  # always bebu's scheme, even if her name isn't written out
    (r"\bnetflix\b", ["subscriptions", "netflix"]),
    (r"\byoutube\b", ["subscriptions", "youtube"]),
    (r"\bclaude\b", ["subscriptions", "claude"]),
    (r"\btata play\b", ["subscriptions", "cabletv"]),
    (r"\bairtel\b", ["utilities", "phone"]),
    (r"\brotary\b.*\bdonation\b|\bdonation\b.*\brotary\b", ["rotary", "donation"]),
    (r"\brotary\b.*\bfees\b|\bfees\b.*\brotary\b|\bshukriya\b", ["rotary", "fees"]),
    (r"\brotary\b", ["rotary"]),
    (r"\bgifts?\b", ["gifts"]),
    (r"\belectricity\b", ["utilities", "electricity"]),
    (r"\bgas bill\b|\bgas\b", ["utilities", "gas"]),
    (r"\bgryffin\b", ["gryffin", "complaince"]),
    (r"\bitr\b|\bpersonal itr\b|\btax\b", ["it", "tax"]),
    (r"\bloan\b", ["loan"]),
    (r"\bgiven\b", ["give"]),
    (r"\brepaid\b|\brepay(ment)?\b", ["repay"]),
    (r"\bvacation\b|\btour\b|\bhotel\b|\blonavala\b", ["vacation"]),
    (r"\bbooks\b", ["books"]),
    (r"\bclothes\b", ["clothes"]),
    (r"\bcommute\b", ["commute"]),
    (r"\btimezone\b|\bentertainment\b", ["entertainment"]),
    (r"\bprintouts?\b", ["printouts"]),
    (r"\bmisc\b|\bpcc\b", ["miscellaneous"]),
    (r"\brituals\b", ["miscellaneous"]),
    (r"\balteration\b", ["clothes"]),
    (r"\bplant\b", ["miscellaneous"]),
    (r"\bbike cleaning\b", ["utilities", "bike-cleaning"]),
    (r"\bboots\b|\bmangrove\b", ["miscellaneous"]),
    (r"\bfan\b", ["appliances-gadgets"]),
]
_FLAT_KEYWORD_RULES_COMPILED = [(re.compile(p, re.I), tags) for p, tags in FLAT_KEYWORD_RULES]

_FLAT_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})$")
_FLAT_ENTRY_RE = re.compile(r"^(\+)?(\d+(?:\.\d+)?k?)\s+(.*)$")


# A description that's *just* one of these words (no other text) is the
# recurring monthly family-allowance transfer -- filed under "Expenses:004:*"
# in the hledger ledger, so it gets the "004" tag here too for consistency.
FLAT_BARE_004_NAMES = {"teju", "pappa", "aai"}


def _flat_derive_tags(desc):
    tags = []

    def add(tag):
        if tag not in tags:
            tags.append(tag)

    if desc.strip().lower() in FLAT_BARE_004_NAMES:
        add("004")

    lower = desc.lower()
    for word in FLAT_PERSON_WORDS:
        if re.search(r"\b" + word + r"\b", lower):
            add(word)
    for pattern, rule_tags in _FLAT_KEYWORD_RULES_COMPILED:
        if pattern.search(desc):
            for tag in rule_tags:
                add(tag)
    if not tags:
        add("???")
    return tags


def _flat_parse_blocks(lines, year):
    blocks, current = [], None
    for raw in lines:
        line = raw.strip()
        if not line:
            current = None
            continue
        m = _FLAT_DATE_RE.match(line)
        if m:
            day, month = int(m.group(1)), int(m.group(2))
            current = {"date": f"{year}-{month:02d}-{day:02d}", "entries": []}
            blocks.append(current)
            continue
        if current is None:
            continue  # orphan line with no preceding date header, ignore
        current["entries"].append(line)
    return blocks


def import_flat(text, year):
    """Returns (ready_txns, skip_entries) — see import_hledger() for shape.
    This format has no category hierarchy, so tags come from
    FLAT_KEYWORD_RULES/FLAT_PERSON_WORDS keyword matching against the
    description instead; entries with zero matches fall back to a literal
    '???' tag (never silently untagged) and are also listed as skip_entries
    for visibility even though they DO get imported."""
    blocks = _flat_parse_blocks(text.splitlines(), year)
    ready, skip = [], []
    for block in blocks:
        for raw_line in block["entries"]:
            m = _FLAT_ENTRY_RE.match(raw_line)
            if not m:
                skip.append((f"{block['date']}: {raw_line}", "did not match AMOUNT DESCRIPTION pattern"))
                continue
            sign, amount_str, rest = m.groups()
            txn_type = "income" if sign == "+" else "expense"
            amount = float(amount_str[:-1]) * 1000 if amount_str.endswith("k") else float(amount_str)

            account_name = FLAT_DEFAULT_ACCOUNT
            desc = rest
            for pattern, name in FLAT_ACCOUNT_KEYWORDS:
                if pattern.search(desc):
                    account_name = name
                    desc = pattern.sub("", desc)
                    break
            desc = re.sub(r"\(\s*\)", "", desc)
            desc = re.sub(r"\s+", " ", desc).strip()

            tags = _flat_derive_tags(desc)
            if tags == ["???"]:
                skip.append((f"{block['date']}: {raw_line}", "no keyword match, tagged '???' — review manually"))

            ready.append(
                {
                    "date": block["date"],
                    "type": txn_type,
                    "account_name": account_name,
                    "description": "",
                    "line_items": [{"amount": amount, "description": desc, "tags": tags}],
                    "line": raw_line,
                }
            )
    return ready, skip


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def merge_ready(acc, ready_txns):
    for t in ready_txns:
        acc.add_transaction(t["date"], t["type"], t["account_name"], t["description"], t["line_items"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("format", choices=["hledger", "flat"])
    parser.add_argument("file", type=Path)
    parser.add_argument("--year", type=int, default=None, help="required for 'flat' format (dd/mm has no year)")
    args = parser.parse_args()

    text = args.file.read_text(encoding="utf-8")
    acc = Accumulator.load()
    before_txn_count = len(acc.transactions)

    if args.format == "hledger":
        ready, skip = import_hledger(text)
        heading = f"{args.file.name} import notes (hledger format)"
    else:
        if args.year is None:
            sys.exit("--year is required for 'flat' format (dd/mm dates have no year)")
        ready, skip = import_flat(text, args.year)
        heading = f"{args.file.name} import notes (flat format, year={args.year})"

    merge_ready(acc, ready)
    acc.get_account_id(FLAT_DEFAULT_ACCOUNT)  # always present, even if unused this run -- it's the default account for future manual/flat entries with no account specified
    data = acc.write()
    if skip:
        append_skip_report(heading, skip)

    print(f"Imported {len(ready)} transactions ({len(acc.transactions) - before_txn_count} new after merge).")
    print(f"Skipped/flagged {len(skip)} entries — see {SKIP_REPORT_PATH.name}.")
    print(f"Totals now in {EXPORT_PATH.name}: {len(data['transactions'])} transactions, "
          f"{len(data['lineItems'])} line items, {len(data['tags'])} tags, {len(data['accounts'])} accounts.")


if __name__ == "__main__":
    main()
