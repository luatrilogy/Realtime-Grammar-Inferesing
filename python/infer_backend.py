import sys, json, re
from collections import Counter, defaultdict

IDENT_RE = r"[A-Za-z_][A-Za-z0-9_]*"
NUM_RE   = r"(?:0|[1-9][0-9]*)"
STR_RE   = r"\"([^\"\\]|\\.)*\"|'([^'\\]|\\.)*'"
OPS      = [
    "==","!=", "<=", ">=", "&&","||","+=","-=","*=","/=","%=",
    "++","--","->","::","<<",">>", "<",">","=","+","-","*","/","%","^","&","|","~","!"
]
PUNCT    = list("(){}[];,.:?")

TOKEN_RE = re.compile(
    f"{STR_RE}|{IDENT_RE}|{NUM_RE}|" +
    "|".join(re.escape(op) for op in sorted(OPS, key=len, reverse=True)) +
    "|[" + re.escape("".join(PUNCT)) + "]"
)

KEYWORDS = {
    "if","else","while","for","return","switch","case","break","continue",
    "def","class","try","except","finally","with","lambda","func","var","let","const"
}

def tokenize(text: str):
    return TOKEN_RE.findall(text), [m.group(0) for m in TOKEN_RE.finditer(text)]

def build_grammar(tokens):
    # Flatten regex capture tuples from STR_RE; keep raw token list
    toks = tokens

    # Inventories
    idents   = [t for t in toks if re.fullmatch(IDENT_RE, t) and t not in KEYWORDS]
    numbers  = [t for t in toks if re.fullmatch(NUM_RE, t)]
    strings  = [t for t in toks if re.fullmatch(STR_RE, t)]
    ops      = [t for t in toks if t in OPS]
    punct    = [t for t in toks if t in PUNCT]
    kws      = sorted(set(t for t in toks if t in KEYWORDS))

    op_counts = Counter(ops)

    # Decide “codey” by structure, not just presence of '(' etc.
    codey = any(x in toks for x in (";", "{", "}", "=", "if", "while", "for")) or len(op_counts) >= 2

    # Operator productions based on *observed* operators
    add_ops = [op for op in ["+","-"] if op in op_counts]
    mul_ops = [op for op in ["*","/","%"] if op in op_counts]
    rel_ops = [op for op in ["<",">","<=",">=","==","!="] if op in op_counts]
    bit_ops = [op for op in ["&","|","^","<<",">>"] if op in op_counts]
    assign_ops = [op for op in ["=","+=","-=","*=","/=","%="] if op in op_counts]

    def alts(xs): 
        return " | ".join(f"'{x}'" for x in xs) if xs else "ε"

    # Non-terminals assembled dynamically
    lines = []
    lines.append("start: Program;")

    if codey:
        lines += [
            "Program -> StmtList",
            "StmtList -> Stmt ';' StmtList | Stmt | ε",
        ]

        # Statement forms inferred by keywords seen
        stmt_alts = ["Assign", "Expr"]
        if "if" in kws:    stmt_alts.append("If")
        if "while" in kws: stmt_alts.append("While")
        if "for" in kws:   stmt_alts.append("For")
        if "return" in kws:stmt_alts.append("Return")
        lines.append("Stmt -> " + " | ".join(stmt_alts))

        if assign_ops:
            lines.append(f"Assign -> ID AssignOp Expr")
            lines.append(f"AssignOp -> {alts(assign_ops)}")

        if "return" in kws:
            lines.append("Return -> 'return' Expr")

        if "if" in kws:
            lines.append("If -> 'if' '(' Expr ')' Stmt OptElse")
            if "else" in kws:
                lines.append("OptElse -> 'else' Stmt | ε")
            else:
                lines.append("OptElse -> ε")

        if "while" in kws:
            lines.append("While -> 'while' '(' Expr ')' Stmt")

        if "for" in kws:
            lines.append("For -> 'for' '(' OptAssign ';' OptExpr ';' OptAssign ')' Stmt")
            lines.append("OptAssign -> Assign | ε")
            lines.append("OptExpr -> Expr | ε")

        # Expression with operator tiers *present in the file*
        tier = []
        if bit_ops: tier.append(("BitExpr", bit_ops))
        if rel_ops: tier.append(("RelExpr", rel_ops))
        if add_ops: tier.append(("AddExpr", add_ops))
        if mul_ops: tier.append(("MulExpr", mul_ops))

        # Fall back tiers if none observed
        if not tier:
            tier = [("AddExpr", ["+","-"]), ("MulExpr", ["*","/"])]

        # Build tiers
        prev = "Factor"
        for name, ops_here in reversed(tier):
            lines.append(f"{name} -> {prev} {name}Tail")
            lines.append(f"{name}Tail -> {alts(ops_here)} {prev} {name}Tail | ε")
            prev = name
        lines.append(f"Expr -> {tier[0][0] if tier else 'Factor'}")

        # Factor: terminals detected
        lines.append("Factor -> ID | NUM | STR | '(' Expr ')'")

    else:
        # Simple NP/VP that adapts vocabulary
        # Use some most-common idents as nouns/verbs
        id_freq = Counter(idents)
        ids_sorted = [w for w,_ in id_freq.most_common(8)]
        nouns = ids_sorted[:4] or ["thing","idea"]
        verbs = ids_sorted[4:8] or ["do","make"]
        lines += [
            "Program -> S",
            "S -> NP VP",
            "NP -> Det N",
            "VP -> V NP | V",
            "Det -> 'the' | 'a'",
            "N -> " + " | ".join(f"'{n}'" for n in nouns),
            "V -> " + " | ".join(f"'{v}'" for v in verbs),
        ]

    # Assemble terminals (ID/NUM/STR)
    lines.append("ID -> /[A-Za-z_][A-Za-z0-9_]*/")
    lines.append("NUM -> /(?:0|[1-9][0-9]*)/")
    lines.append("STR -> /\"([^\"\\\\]|\\\\.)*\"|'([^'\\\\]|\\\\.)*'/")

    return ";\n".join(lines) + ";"

def main():
    try:
        payload = sys.stdin.read()
        data = json.loads(payload or "{}")
        corpus = data.get("corpus", "")
        # Tokenize
        _, toks = tokenize(corpus)
        grammar = build_grammar(toks)
        out = {
            "grammar": grammar,
            "metrics": {
                "num_tokens": len(toks),
                "unique_ops": sorted(list(set(t for t in toks if t in OPS))),
                "has_keywords": sorted(list(set(t for t in toks if t in KEYWORDS))),
            }
        }
        sys.stdout.write(json.dumps(out))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()