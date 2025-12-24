# Realtime Grammar Inferencing — VS Code Extension
Real time grammar inferencing directly in VS Code with any open file. 
Visualize the results with first/follow sets, nonterminal dependency graphs
and a parse tree.

# Requirements
VS Code 1.8x+
Python 3.10+ available on PATH (or configure pythonPath setting)

# Install (from source)
Clone this repo and open it in VS Code.
npm install
Press F5 to launch the Extension Development Host.

# Core commands

Infer Grammar from Active File
utaGrammarLab.inferFromActive
Reads the active editor text → opens an untitled document with the inferred grammar and a short metrics header.

Infer Grammar from File…
utaGrammarLab.inferFromFile
Pick any file and infer its grammar.

Visualize Grammar
uta.gram.visualize
Opens the visualizer webview (FIRST/FOLLOW, dependency sketch, parse sandbox, export SVG).
If the panel is open, inference commands also send metrics/grammar to it automatically.

# Power tools
Preview Inference (fast, sampled)
uta.infer.preview

Full Inference (longer, higher budget)
uta.infer.full

Compare Inferred Grammars (A ↔ B)
utaGrammarLab.diffGrammars
Diff two .gram / .gramdsl docs (open or pick from disk).

Check Grammar Coverage on File…
utaGrammarLab.checkCoverage
Choose a grammar doc, then choose a source file; uncovered lines are gently highlighted.

Generate Random Programs from Grammar
utaGrammarLab.fuzzGrammar
Uses a probabilistic expander to emit 10 sample sentences/programs from the active grammar.

# NEED TO RUN
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm --version
npm run compile

# Grammar Inference Efficiency Testing
Run in Console 

cd projet_path

node .\out-server\bench.js --train .\examples\[TRAINING_SET] --out .\grammar_output\[OUTPUT_FILE].json --lang while --sample 200 --max_mb 8 --time_budget 60 --verbose

