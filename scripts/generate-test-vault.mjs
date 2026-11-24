#!/usr/bin/env node
// Builds a large synthetic Obsidian vault for testing the 3D graph with
// thousands of nodes.
//
// The note text is filler. What's modeled is the link structure of a vault
// that has grown for about five years: daily notes, meetings, projects, people,
// sources, interlinked topic notes, and maps of content. That gives hubs,
// clusters, bridges between topics, mutual links, orphans, nested tags,
// attachments, and unresolved links. Notes mostly link to notes that already
// existed when they were written, and file creation times follow that history,
// so the graph's timelapse replays the vault growing.
//
//   node scripts/generate-test-vault.mjs [--out <dir>] [--scale <n>] [--seed <n>] [--no-plugin]
//
// Running it again replaces the generated notes but keeps the vault's
// .obsidian folder (plugin settings, workspace).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/generate-test-vault.mjs [options]

  --out <dir>    where to write the vault (default: ./test-vault in the repo)
  --scale <n>    multiplies the number of notes other than journal notes
                 (default 1, about 5,000 notes; 3 gives about 12,000)
  --seed <n>     random seed, the same seed builds the same vault (default 1)
  --no-plugin    don't install this repo's built plugin into the vault`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".generated-test-vault";

const fail = (message) => {
	console.error(message);
	process.exit(1);
};

const opts = { out: path.join(repoRoot, "test-vault"), scale: 1, seed: 1, plugin: true };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	const value = () => {
		const v = argv[++i];
		if (v === undefined || v.startsWith("--")) fail(`${arg} needs a value\n\n${USAGE}`);
		return v;
	};
	if (arg === "--out") opts.out = path.resolve(value());
	else if (arg === "--scale") opts.scale = Number(value());
	else if (arg === "--seed") opts.seed = Number(value());
	else if (arg === "--no-plugin") opts.plugin = false;
	else if (arg === "--help" || arg === "-h") {
		console.log(USAGE);
		process.exit(0);
	} else fail(`Unknown option: ${arg}\n\n${USAGE}`);
}
if (!Number.isFinite(opts.scale) || opts.scale <= 0) fail("--scale must be a positive number");
if (!Number.isInteger(opts.seed)) fail("--seed must be an integer");

// ------------------------------------------------------------------ random

let rngState = opts.seed >>> 0;
const rand = () => {
	// mulberry32
	rngState = (rngState + 0x6d2b79f5) >>> 0;
	let t = rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
// favors the start of the array: a few popular items and a long tail
const skewed = (arr, k = 2.2) => arr[Math.floor(Math.pow(rand(), k) * arr.length)];
const shuffle = (arr) => {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
};
const skewedSample = (arr, n, k = 2.2) => {
	const chosen = new Set();
	for (let tries = 0; chosen.size < Math.min(n, arr.length) && tries < n * 20; tries++)
		chosen.add(skewed(arr, k));
	return [...chosen];
};
const poisson = (mean) => {
	const limit = Math.exp(-mean);
	let k = 0;
	for (let p = rand(); p > limit; p *= rand()) k++;
	return k;
};
// heavy-tailed: most notes have a few links, some have dozens
const linkCount = (mean) =>
	Math.min(35, Math.floor(-Math.log(1 - rand()) * mean * (chance(0.07) ? 3 : 1)) + 1);
const scaled = (n) => Math.max(1, Math.round(n * opts.scale));

// ------------------------------------------------------------------- dates

const DAY = 86400000;
const START = Date.UTC(2022, 0, 3); // a Monday
const TOTAL_DAYS = Math.round((Date.UTC(2026, 10, 20) - START) / DAY);
const UTC_OFFSET = 5 * 3600000; // times are written as if the owner lives in US Eastern
const END_TIME = START + TOTAL_DAYS * DAY + 22 * 3600000 + UTC_OFFSET;

const dateOf = (d) => new Date(START + d * DAY);
const ymd = (d) => dateOf(d).toISOString().slice(0, 10);
const yearOf = (d) => dateOf(d).getUTCFullYear();
const isWeekend = (d) => [0, 6].includes(dateOf(d).getUTCDay());
const dayOfDate = (y, m, dd) => Math.round((Date.UTC(y, m, dd) - START) / DAY);
const timeOn = (d, fromHour = 7, toHour = 23) =>
	START + d * DAY + int(fromHour * 60, toHour * 60 - 1) * 60000 + UTC_OFFSET;
const clampDay = (d) => Math.max(0, Math.min(TOTAL_DAYS, Math.round(d)));
const isoWeek = (d) => {
	const date = dateOf(d);
	const dayNum = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - dayNum);
	const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};
const localStamp = (ms) => new Date(ms - UTC_OFFSET).toISOString().slice(0, 16);

// ------------------------------------------------------------------- words

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// characters Obsidian doesn't allow in file names
const clean = (s) =>
	s.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");

const LOREM = (
	"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore " +
	"et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip " +
	"ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla " +
	"pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim " +
	"id est laborum curabitur pretium tincidunt lacus nulla gravida orci a odio nullam varius turpis"
).split(" ");
const sentence = (words) =>
	cap(Array.from({ length: words }, () => pick(LOREM)).join(" ")) + ".";

const ADJECTIVES = ["Advanced", "Practical", "Hidden", "Incremental", "Everyday", "Minimal", "Applied", "Intuitive", "Unexpected", "Defensive"];
const CONCEPT_PATTERNS = [
	(t, u) => `${cap(t)} vs ${u}`,
	(t) => `${cap(t)} in practice`,
	(t) => `Why ${t} matters`,
	(t) => `How ${t} works`,
	(t, u) => `${cap(t)} and ${u}`,
	(t) => `Notes on ${t}`,
	(t) => `${cap(t)} - common pitfalls`,
	(t) => `When to use ${t}`,
	(t) => `${cap(t)} examples`,
	(t) => `The case against ${t}`,
	(t) => `${pick(ADJECTIVES)} ${t}`,
	(t) => `${cap(t)} checklist`,
	(t) => `Questions about ${t}`,
	(t) => `${cap(t)} for beginners`,
	(t) => `A short history of ${t}`,
	(t) => `${cap(t)} trade-offs`,
	(t, u) => `${cap(t)} through the lens of ${u}`,
	(t) => `Misconceptions about ${t}`,
	(t) => `${cap(t)} - open questions`,
];
const BOOK_PATTERNS = [
	(t) => `The Art of ${cap(t)}`,
	(t) => `${cap(t)} - A Practical Guide`,
	(t) => `Thinking in ${cap(t)}`,
	(t) => `${cap(t)} for Humans`,
	(t) => `Mastering ${cap(t)}`,
	(t) => `On ${cap(t)}`,
	(t, u) => `${cap(t)}, ${cap(u)}, and Everything Between`,
	(t) => `The ${cap(t)} Handbook`,
	(t) => `A Field Guide to ${cap(t)}`,
];
const ARTICLE_PATTERNS = [
	(t) => `${cap(t)} considered harmful`,
	(t) => `A gentle introduction to ${t}`,
	(t) => `What I learned about ${t}`,
	(t) => `${cap(t)} explained`,
	(t) => `Against ${t}`,
	(t) => `The surprising power of ${t}`,
	(t) => `Lessons from ${int(2, 15)} years of ${t}`,
	(t, u) => `From ${t} to ${u}`,
	(t) => `${cap(t)} is not what you think`,
];
const PAPER_PATTERNS = [
	(t) => `A survey of ${t}`,
	(t) => `Towards practical ${t}`,
	(t) => `Revisiting ${t}`,
	(t) => `Scalable ${t}`,
	(t, u) => `${cap(t)} meets ${u}`,
	(t) => `On the limits of ${t}`,
	(t) => `${cap(t)} is all you need`,
];
const VIDEO_PATTERNS = [
	(t) => `${cap(t)} in ${pick([10, 15, 20, 45])} minutes`,
	(t) => `Talk - ${cap(t)} at ${pick(["StrangeLoop", "QCon", "PyCon", "RustConf", "NeurIPS", "SXSW"])} ${int(2019, 2025)}`,
	(t) => `Lecture - ${cap(t)}`,
	(t) => `Workshop - hands-on ${t}`,
];

// ------------------------------------------------------------------ topics

const TOPICS = [
	{ name: "Software Engineering", tag: "software", weight: 10, core: true, subs: [
		{ name: "Rust", tag: "rust", terms: ["ownership", "borrowing", "lifetimes", "traits", "async Rust", "the borrow checker", "cargo workspaces", "error handling in Rust", "smart pointers", "pattern matching", "declarative macros", "unsafe Rust", "Tokio", "Serde", "iterators", "zero-cost abstractions"] },
		{ name: "TypeScript", tag: "typescript", terms: ["structural typing", "generics", "discriminated unions", "type narrowing", "conditional types", "mapped types", "declaration files", "strict mode", "module resolution", "type inference", "utility types", "branded types", "the Node.js event loop", "bundlers"] },
		{ name: "Distributed systems", tag: "distributed-systems", terms: ["consensus", "Raft", "Paxos", "the CAP theorem", "eventual consistency", "vector clocks", "idempotency", "backpressure", "leader election", "sharding", "replication", "gossip protocols", "exactly-once delivery", "distributed tracing", "circuit breakers", "sagas"] },
		{ name: "Databases", tag: "databases", terms: ["B-trees", "LSM trees", "write-ahead logging", "MVCC", "query planning", "covering indexes", "isolation levels", "Postgres vacuum", "connection pooling", "normalization", "denormalization", "CRDTs", "SQLite", "change data capture"] },
		{ name: "Software design", tag: "design-patterns", terms: ["dependency injection", "hexagonal architecture", "domain-driven design", "event sourcing", "CQRS", "SOLID principles", "coupling and cohesion", "technical debt", "code review", "refactoring", "the testing pyramid", "property-based testing", "feature flags", "C++ templates"] },
	] },
	{ name: "Machine Learning", tag: "ml", weight: 7, subs: [
		{ name: "Deep learning", tag: "deep-learning", terms: ["backpropagation", "transformers", "attention", "embeddings", "convolutional networks", "residual connections", "layer normalization", "dropout", "batch size", "learning rate schedules", "gradient descent", "overfitting", "regularization", "tokenization"] },
		{ name: "LLMs", tag: "llms", terms: ["prompt engineering", "retrieval-augmented generation", "fine-tuning", "RLHF", "context windows", "scaling laws", "evaluation harnesses", "hallucination", "tool use", "agents", "chain of thought", "quantization", "distillation"] },
		{ name: "Classical ML", tag: "classical-ml", terms: ["linear regression", "logistic regression", "decision trees", "random forests", "gradient boosting", "k-means", "PCA", "cross-validation", "the bias-variance tradeoff", "feature engineering", "naive Bayes", "SVMs"] },
	] },
	{ name: "Mathematics", tag: "math", weight: 4, subs: [
		{ name: "Linear algebra", tag: "linear-algebra", terms: ["eigenvalues", "matrix decomposition", "vector spaces", "SVD", "determinants", "orthogonality", "change of basis", "linear maps", "inner products"] },
		{ name: "Probability", tag: "probability", terms: ["Bayes' theorem", "the central limit theorem", "hypothesis testing", "p-values", "confidence intervals", "Markov chains", "expected value", "variance", "conditional probability", "the base rate fallacy", "regression to the mean", "Monte Carlo methods"] },
		{ name: "Discrete math", tag: "discrete-math", terms: ["graph theory", "combinatorics", "induction", "modular arithmetic", "recurrence relations", "Big-O notation", "the pigeonhole principle", "set theory"] },
	] },
	{ name: "Philosophy", tag: "philosophy", weight: 5, core: true, subs: [
		{ name: "Stoicism", tag: "stoicism", terms: ["the dichotomy of control", "memento mori", "amor fati", "Marcus Aurelius", "Seneca", "Epictetus", "negative visualization", "virtue ethics", "premeditatio malorum", "the view from above"] },
		{ name: "Epistemology", tag: "epistemology", terms: ["justified true belief", "Gettier problems", "Bayesian epistemology", "skepticism", "falsifiability", "the problem of induction", "rationalism", "empiricism", "epistemic humility", "Occam's razor"] },
		{ name: "Ethics", tag: "ethics", terms: ["utilitarianism", "deontology", "the trolley problem", "moral luck", "effective altruism", "the veil of ignorance", "consequentialism", "moral realism", "the is-ought problem"] },
	] },
	{ name: "Psychology", tag: "psychology", weight: 6, subs: [
		{ name: "Cognitive biases", tag: "biases", terms: ["confirmation bias", "anchoring", "the availability heuristic", "the sunk cost fallacy", "the Dunning-Kruger effect", "hindsight bias", "the planning fallacy", "survivorship bias", "loss aversion", "status quo bias", "the fundamental attribution error"] },
		{ name: "Habits", tag: "habits", terms: ["habit loops", "implementation intentions", "temptation bundling", "identity-based habits", "the two-minute rule", "environment design", "dopamine", "willpower", "motivation", "behavior change"] },
		{ name: "Learning science", tag: "learning", terms: ["spaced repetition", "retrieval practice", "interleaving", "the forgetting curve", "desirable difficulties", "elaboration", "chunking", "deliberate practice", "the testing effect", "metacognition"] },
	] },
	{ name: "Productivity", tag: "productivity", weight: 7, core: true, subs: [
		{ name: "PKM", tag: "pkm", terms: ["Zettelkasten", "evergreen notes", "atomic notes", "progressive summarization", "maps of content", "linking your thinking", "the PARA method", "fleeting notes", "literature notes", "digital gardens", "a second brain", "backlinks"] },
		{ name: "Time management", tag: "time", terms: ["time blocking", "Getting Things Done", "the weekly review", "the Eisenhower matrix", "deep work", "timeboxing", "the Pomodoro technique", "the maker's schedule", "energy management", "inbox zero", "task batching"] },
	] },
	{ name: "Writing", tag: "writing", weight: 4, subs: [
		{ name: "Fiction craft", tag: "fiction", terms: ["show, don't tell", "active voice", "story structure", "the hero's journey", "dialogue", "point of view", "first drafts", "narrative voice", "pacing", "narrative tension", "worldbuilding"] },
		{ name: "Nonfiction", tag: "nonfiction", terms: ["essay structure", "writing hooks", "clear thinking", "argument mapping", "outlining", "plain language", "technical writing", "documentation", "writing in public", "the inverted pyramid"] },
	] },
	{ name: "Health", tag: "health", weight: 5, subs: [
		{ name: "Fitness", tag: "fitness", terms: ["zone 2 training", "VO2 max", "progressive overload", "hypertrophy", "mobility", "running form", "marathon training", "strength training", "recovery", "deload weeks", "heart rate variability", "periodization"] },
		{ name: "Nutrition", tag: "nutrition", terms: ["macronutrients", "fiber", "intermittent fasting", "the glycemic index", "micronutrients", "hydration", "the gut microbiome", "ultra-processed foods", "creatine", "caffeine", "protein intake"] },
		{ name: "Sleep", tag: "sleep", terms: ["circadian rhythm", "sleep hygiene", "REM sleep", "sleep debt", "melatonin", "chronotypes", "napping", "blue light"] },
	] },
	{ name: "Cooking", tag: "cooking", weight: 4, subs: [
		{ name: "Cooking techniques", tag: "techniques", terms: ["the Maillard reaction", "emulsions", "braising", "sous vide", "knife skills", "mise en place", "deglazing", "brining", "fermentation", "sourdough", "stock making", "pan sauces", "tempering chocolate"] },
		{ name: "Cuisines", tag: "cuisines", terms: ["Italian regional cooking", "Japanese home cooking", "Sichuan peppercorns", "Mexican moles", "French mother sauces", "Indian spice blends", "Korean banchan", "Thai curry pastes", "Levantine mezze", "crème brûlée"] },
	] },
	{ name: "Finance", tag: "finance", weight: 4, subs: [
		{ name: "Investing", tag: "investing", terms: ["index funds", "asset allocation", "compound interest", "rebalancing", "dollar-cost averaging", "expense ratios", "tax-loss harvesting", "bond ladders", "sequence of returns risk", "the 4% rule", "diversification"] },
		{ name: "Personal finance", tag: "personal-finance", terms: ["emergency funds", "budgeting", "zero-based budgeting", "Roth IRAs", "401k plans", "HSAs", "credit scores", "net worth tracking", "sinking funds", "mortgage amortization"] },
	] },
	{ name: "Economics", tag: "economics", weight: 3, subs: [
		{ name: "Microeconomics", tag: "micro", terms: ["supply and demand", "opportunity cost", "marginal utility", "price elasticity", "externalities", "game theory", "Nash equilibrium", "comparative advantage", "the tragedy of the commons", "the principal-agent problem", "moral hazard"] },
		{ name: "Macroeconomics", tag: "macro", terms: ["inflation", "monetary policy", "fiscal policy", "interest rates", "GDP", "unemployment", "the business cycle", "quantitative easing", "trade deficits"] },
	] },
	{ name: "History", tag: "history", weight: 3, subs: [
		{ name: "Ancient history", tag: "ancient", terms: ["the Roman Republic", "the fall of Rome", "Athenian democracy", "the Silk Road", "the Bronze Age collapse", "Alexander the Great", "the Han dynasty", "Carthage", "the Library of Alexandria"] },
		{ name: "Modern history", tag: "modern", terms: ["the Industrial Revolution", "the printing press", "the Cold War", "the Meiji Restoration", "the Marshall Plan", "decolonization", "the space race", "the Enlightenment", "the French Revolution"] },
	] },
	{ name: "Science", tag: "science", weight: 3, subs: [
		{ name: "Physics", tag: "physics", terms: ["entropy", "quantum entanglement", "general relativity", "special relativity", "the double-slit experiment", "thermodynamics", "dark matter", "the Standard Model", "wave-particle duality", "Feynman diagrams"] },
		{ name: "Biology", tag: "biology", terms: ["natural selection", "CRISPR", "the central dogma", "mitochondria", "epigenetics", "homeostasis", "neurons", "the immune system", "horizontal gene transfer", "symbiosis"] },
	] },
	{ name: "Music", tag: "music", weight: 2, subs: [
		{ name: "Music theory", tag: "theory", terms: ["the circle of fifths", "modes", "chord progressions", "voice leading", "the ii-V-I", "secondary dominants", "tritone substitution", "counterpoint", "polyrhythms", "ear training"] },
		{ name: "Guitar", tag: "guitar", terms: ["fingerstyle", "barre chords", "the CAGED system", "alternate picking", "open tunings", "guitar setup", "string gauges", "pentatonic boxes"] },
	] },
	{ name: "Languages", tag: "languages", weight: 3, subs: [
		{ name: "Japanese", tag: "japanese", terms: ["hiragana", "katakana", "kanji radicals", "敬語", "日本語の助詞", "pitch accent", "counters", "the te-form", "JLPT N3", "verb conjugation", "onomatopoeia"] },
		{ name: "Spanish", tag: "spanish", terms: ["the subjunctive", "ser vs estar", "preterite vs imperfect", "por and para", "false friends", "rolling Rs", "voseo", "reflexive verbs", "café vocabulary"] },
	] },
	{ name: "Travel", tag: "travel", weight: 3, subs: [
		{ name: "Trips", tag: "trips", terms: ["Kyoto", "Lisbon", "Mexico City", "Zürich", "São Paulo", "Reykjavík", "Hanoi", "Patagonia", "the Scottish Highlands", "Marrakech", "Vancouver Island"] },
		{ name: "Travel planning", tag: "planning", terms: ["packing lists", "travel insurance", "jet lag", "points and miles", "one-bag travel", "train travel in Europe", "travel photography", "visa requirements"] },
	] },
	{ name: "Home", tag: "home", weight: 4, subs: [
		{ name: "Gardening", tag: "gardening", terms: ["companion planting", "composting", "raised beds", "tomato varieties", "seed starting", "pruning", "cover crops", "soil pH", "perennial herbs", "watering schedules"] },
		{ name: "Home lab", tag: "homelab", terms: ["Proxmox", "Home Assistant", "ZFS pools", "Tailscale", "reverse proxies", "Pi-hole", "NAS backups", "Docker Compose", "self-hosting", "VLANs", "UPS sizing"] },
	] },
	{ name: "Design", tag: "design", weight: 3, subs: [
		{ name: "UX", tag: "ux", terms: ["affordances", "Fitts's law", "Hick's law", "progressive disclosure", "information architecture", "usability testing", "dark patterns", "accessibility", "design systems", "onboarding flows", "empty states"] },
		{ name: "Visual design", tag: "visual", terms: ["typography", "color theory", "grid systems", "visual hierarchy", "whitespace", "kerning", "contrast ratios", "iconography", "Gestalt principles"] },
	] },
	{ name: "Leadership", tag: "leadership", weight: 5, subs: [
		{ name: "Management", tag: "management", terms: ["one-on-ones", "delegation", "giving feedback", "psychological safety", "hiring", "performance reviews", "career ladders", "team topologies", "managing up", "OKRs", "burnout", "conflict resolution"] },
		{ name: "Strategy", tag: "strategy", terms: ["Wardley maps", "the innovator's dilemma", "moats", "jobs to be done", "flywheels", "platform strategy", "product-market fit", "build vs buy", "north star metrics", "pricing strategy"] },
	] },
	{ name: "Photography", tag: "photography", weight: 1.5, subs: [
		{ name: "Photography basics", tag: "basics", terms: ["the exposure triangle", "aperture", "shutter speed", "ISO", "composition", "the rule of thirds", "golden hour", "street photography", "film photography", "focal length"] },
	] },
];
const AFFINITY = [
	["software", "ml"], ["software", "math"], ["software", "design"], ["software", "leadership"], ["software", "home"],
	["ml", "math"], ["ml", "psychology"], ["ml", "philosophy"], ["math", "science"], ["math", "economics"],
	["philosophy", "psychology"], ["philosophy", "history"], ["philosophy", "writing"], ["psychology", "productivity"],
	["psychology", "health"], ["psychology", "economics"], ["psychology", "design"], ["productivity", "writing"],
	["productivity", "leadership"], ["writing", "history"], ["health", "cooking"], ["cooking", "travel"],
	["cooking", "home"], ["finance", "economics"], ["finance", "leadership"], ["history", "travel"],
	["history", "economics"], ["science", "ml"], ["music", "math"], ["music", "psychology"], ["languages", "travel"],
	["design", "photography"], ["leadership", "economics"], ["travel", "photography"],
];

const FIRST = ["Ava", "Ben", "Chloe", "Dev", "Elena", "Felix", "Grace", "Hiro", "Isla", "Jonah", "Kira", "Liam", "Maya", "Noah", "Olivia", "Priya", "Quinn", "Rosa", "Sam", "Tariq", "Uma", "Victor", "Wen", "Xavier", "Yara", "Zane", "Amara", "Bruno", "Camila", "Diego", "Emeka", "Fatima", "Gus", "Hana", "Inés", "Jae", "Kofi", "Lena", "Mateo", "Nadia", "Omar", "Petra", "Rafael", "Sofia", "Theo", "Valeria", "Will", "Ximena", "Yusuf", "Zoe", "Aiden", "Bea", "Cyrus", "Dina", "Eli", "Freya", "Gabe", "Hugo", "Ivy", "Jules", "Kai", "Lucia", "Milo", "Nina", "Oscar", "Pia", "Ravi", "Sana", "Tomás", "Vera"];
const LAST = ["Abara", "Bergström", "Castillo", "Dubois", "Eriksen", "Fischer", "Gallagher", "Haddad", "Ivanova", "Jensen", "Kowalski", "Lindqvist", "Moreau", "Nakamura", "O'Connor", "Patel", "Quintero", "Rossi", "Schmidt", "Tanaka", "Ueda", "Vasquez", "Whitfield", "Xu", "Yamamoto", "Zielinski", "Adeyemi", "Brennan", "Chen", "Delgado", "Esposito", "Fontaine", "Gupta", "Holloway", "Iyer", "Jovanovic", "Kim", "Larsen", "Mendes", "Novak", "Okafor", "Park", "Reyes", "Sato", "Thornton", "Varga", "Weiss", "Young", "Zhou", "Ahmed", "Baptiste", "Costa", "Dang", "Ferreira", "Grant", "Horvat", "Ito", "Kaur", "Lopez", "Murphy", "Nguyen", "Olsen", "Petrov", "Romero", "Silva", "Tran", "Volkov", "Walsh"];
const CODENAMES = ["Atlas", "Borealis", "Cascade", "Driftwood", "Ember", "Fathom", "Granite", "Halcyon", "Ironbark", "Juniper", "Kestrel", "Lumen", "Meridian", "Nimbus", "Orchid", "Pinnacle", "Quasar", "Redwood", "Sable", "Tundra", "Umbra", "Vantage", "Willow", "Xenon", "Yarrow", "Zephyr", "Aurora", "Basalt", "Cobalt", "Dune", "Echo", "Falcon", "Gemini", "Harbor", "Indigo", "Jasper", "Keystone", "Lattice", "Mosaic", "Nova", "Onyx", "Prism", "Quarry", "Ripple", "Summit", "Tessera", "Unison", "Vertex", "Wavelength", "Alder", "Bramble", "Cinder", "Delta", "Fjord", "Glacier", "Heron", "Isthmus", "Jetty", "Kelp", "Larch"];
const OTHER_ORGS = ["Acme Analytics", "Bluefin Bank", "Cedar Clinic", "Dovetail Design Co", "Evergreen University", "Foundry Ventures", "Globex Logistics", "Harborview Gym", "Initech", "Juniper Credit Union", "Kite & Key Realty", "Lighthouse Insurance", "Monarch Studios", "Northstar Consulting", "Oakridge Library", "Pinecrest Pediatrics", "Quantum Freight", "Riverside Co-op"];
const PODCASTS = ["The Long Now Hour", "Signal and Noise", "Kitchen Table Science", "Systems Thinking Weekly", "Margins", "Deep Field"];
// generic names that many project folders share, e.g. Projects/Atlas/Overview.md
const SHARED_SUBNOTES = ["Overview", "Roadmap", "Requirements", "Retrospective", "Ideas", "Research", "Decisions", "Risks", "Launch checklist", "Stakeholders", "Budget", "Timeline", "Open questions", "Design doc", "Status updates", "Lessons learned"];
const PERSONAL_SUBNOTES = ["Budget", "Ideas", "Timeline", "Research", "Checklist", "Shopping list", "Contacts", "Open questions"];
const WORK_SPECIFIC = ["API design", "data model", "launch plan", "metrics", "pricing", "migration plan", "incident review", "load test results", "user interviews", "architecture", "security review", "rollout plan", "FAQ", "demo script", "competitive analysis", "vendor evaluation"];
const PERSONAL_SPECIFIC = ["quotes", "cost tracker", "inspiration", "itinerary", "plan", "reading", "progress log", "supplies", "week 1"];
const PERSONAL_PROJECTS = [
	["Kitchen renovation", "home", "Home"], ["Learn Japanese", "languages", "Learning"], ["Spring marathon", "health", "Health"],
	["Home server rebuild", "home", "Home"], ["Wedding planning", "travel", "Relationships"], ["Garden redesign", "home", "Home"],
	["Novel draft", "writing", "Writing"], ["Personal website", "design", "Writing"], ["Move to the new apartment", "home", "Home"],
	["Build a bookshelf", "home", "Home"], ["Photography portfolio", "photography", "Writing"], ["Sourdough mastery", "cooking", "Health"],
	["Emergency fund", "finance", "Finance"], ["Japan trip", "travel", "Travel"], ["100 days of guitar", "music", "Learning"],
	["Newsletter launch", "writing", "Writing"], ["Car purchase", "finance", "Finance"], ["Family reunion", "travel", "Relationships"],
	["Learn piano", "music", "Learning"], ["Couch to 5K", "health", "Health"], ["Portugal trip", "travel", "Travel"],
	["Tax prep 2024", "finance", "Finance"], ["Tax prep 2025", "finance", "Finance"], ["Retirement plan review", "finance", "Finance"],
];
const AREAS = [
	{ name: "Health", topics: ["health"], notes: ["Annual physical 2023", "Annual physical 2024", "Annual physical 2025", "Bloodwork results", "Running log", "Injury - left knee", "Supplements", "Dentist", "Therapy notes"] },
	{ name: "Finance", topics: ["finance", "economics"], notes: ["Budget 2022", "Budget 2023", "Budget 2024", "Budget 2025", "Budget 2026", "Net worth tracker", "Investment policy statement", "Taxes 2023", "Insurance policies", "Subscriptions audit"] },
	{ name: "Career", topics: ["leadership", "software"], notes: ["Resume", "Brag document", "Career goals", "Job search 2023", "Interview prep", "Salary negotiation notes", "Promotion packet", "Conference talks"] },
	{ name: "Household", topics: ["home"], notes: ["Home maintenance schedule", "Appliance manuals", "Utilities", "Moving checklist", "Paint colors", "Wi-Fi setup"] },
	{ name: "Relationships", topics: ["psychology"], notes: ["Gift ideas", "Birthdays", "Anniversary ideas", "Family tree", "Holiday plans"] },
	{ name: "Learning", topics: ["productivity", "psychology"], notes: ["Reading list", "Courses", "Learning goals", "Anki decks", "Podcast queue"] },
	{ name: "Creative writing", topics: ["writing"], notes: ["Essay ideas", "Newsletter issues", "Writing habit tracker", "Pitch list"] },
	{ name: "Adventures", topics: ["travel"], notes: ["Bucket list", "Travel log", "Master packing list", "Loyalty programs"] },
	{ name: "Goals", topics: ["productivity"], notes: ["2022 Goals", "2023 Goals", "2024 Goals", "2025 Goals", "2026 Goals", "Life vision", "Values"] },
];
const AREA_ALIASES = { Home: "Household", Writing: "Creative writing", Travel: "Adventures" };
const DIAGRAMS = [
	["System architecture", "software"], ["Request lifecycle", "software"], ["Habit loop", "psychology"],
	["Zettelkasten workflow", "productivity"], ["Training block", "health"], ["Budget flow", "finance"],
	["Garden layout", "home"], ["Transformer block", "ml"],
];
const HEADINGS = ["Summary", "Notes", "Key ideas", "Questions", "References", "Details"];
const MOODS = ["good", "tired", "focused", "anxious", "great", "meh"];

// -------------------------------------------------------------------- model

const notes = [];
const attachments = [];
const taken = new Set(); // lowercased names in use (links resolve case-insensitively)
const claim = (name) => {
	const key = name.toLowerCase();
	if (taken.has(key)) return false;
	taken.add(key);
	return true;
};
SHARED_SUBNOTES.concat(PERSONAL_SUBNOTES).forEach((n) => taken.add(n.toLowerCase()));

const makeNote = (name, folder, day, kind, extra = {}) => {
	const note = {
		id: notes.length,
		name,
		folder,
		day,
		kind,
		time: extra.time ?? timeOn(day),
		path: `${folder ? `${folder}/` : ""}${name}.md`,
		fm: {},
		fmTags: [],
		inlineTags: [],
		out: [],
		outKeys: new Set(),
		inDegree: 0,
		heading: chance(0.55),
		...extra,
	};
	notes.push(note);
	return note;
};
const unresolved = (text) => ({ unresolved: text });
const targetKey = (to) =>
	to.unresolved ? `u:${to.unresolved}` : to.isAttachment ? `a:${to.path}` : `n:${to.id}`;
// places: "body", "embed", "nav", "list:<Heading>", "fm:<key>", "field:<key>"
const link = (from, to, place = "body") => {
	if (!from || !to || to === from) return false;
	const key = targetKey(to);
	if (from.outKeys.has(key)) return false;
	from.outKeys.add(key);
	from.out.push({ to, place });
	if (!to.unresolved) to.inDegree++;
	return true;
};

const makeAttachment = (folder, fileName, day, kind) => {
	const att = {
		isAttachment: true,
		name: fileName,
		path: `${folder}/${fileName}`,
		day,
		time: timeOn(day),
		kind,
		inDegree: 0,
	};
	attachments.push(att);
	return att;
};
const imageNames = new Set();
const pastedImage = (day, time = timeOn(day)) => {
	let t = time;
	let name;
	do {
		const stamp = new Date(t - UTC_OFFSET).toISOString().replace(/\D/g, "").slice(0, 14);
		name = `Pasted image ${stamp}.png`;
		t += 1000;
	} while (imageNames.has(name));
	imageNames.add(name);
	const att = makeAttachment("Attachments", name, Math.floor((time - START) / DAY), "png");
	att.time = time;
	return att;
};

// a pool of notes that grows as the vault's history is replayed; "hits"
// holds a note once per link it receives, so drawing from it favors hubs
const pool = () => ({ items: [], hits: [] });
const draw = (p, recentBias = 0.3) => {
	if (!p || p.items.length === 0) return null;
	const r = rand();
	if (r < recentBias) {
		const n = Math.min(25, p.items.length);
		return p.items[p.items.length - 1 - Math.floor(Math.pow(rand(), 1.6) * n)];
	}
	if (r < recentBias + 0.45 && p.hits.length) return pick(p.hits);
	return pick(p.items);
};
const linkFromPool = (from, p, place) => {
	const to = draw(p);
	if (to && link(from, to, place)) {
		p.hits.push(to);
		return to;
	}
	return null;
};

// --------------------------------------------------------- topics & interest

const topicByTag = new Map(TOPICS.map((t) => [t.tag, t]));
TOPICS.forEach((t) => {
	t.related = [];
	t.concepts = [];
	t.subs.forEach((s) => {
		s.topic = t;
		s.key = `${t.tag}/${s.tag}`;
		s.weight = 0.6 + rand();
		s.concepts = pool();
		s.sources = pool();
		s.all = [];
		s.allSources = [];
		s.unresolved = [];
		s.bare = shuffle(s.terms.slice());
	});
	t.mocName = clean(`${t.tag === "productivity" ? "🧭 " : ""}${t.name} MOC`);
	claim(t.mocName);
	t.subs.forEach((s) => {
		s.mocName = `${s.name} MOC`;
		claim(s.mocName);
	});
});
AFFINITY.forEach(([a, b]) => {
	topicByTag.get(a).related.push(topicByTag.get(b));
	topicByTag.get(b).related.push(topicByTag.get(a));
});

// each topic has its own history: when the interest started and a few bursts
TOPICS.forEach((t) => {
	const start = t.core ? 0 : chance(0.5) ? int(0, 120) : int(0, Math.floor(TOTAL_DAYS * 0.7));
	const base = 0.05 + rand() * 0.25;
	const bursts = Array.from({ length: int(1, 3) }, () => ({
		center: int(start, TOTAL_DAYS),
		width: int(40, 300),
		height: 0.5 + rand() * 1.5,
	}));
	const cdf = [];
	let sum = 0;
	for (let d = 0; d <= TOTAL_DAYS; d++) {
		let v = 0;
		if (d >= start) {
			v = base;
			bursts.forEach((b) => (v += b.height * Math.exp(-((d - b.center) ** 2) / (2 * b.width ** 2))));
			v *= 0.4 + (0.9 * d) / TOTAL_DAYS; // the vault grows faster over time
		}
		sum += v;
		cdf.push(sum);
	}
	t.sampleDay = () => {
		const x = rand() * sum;
		let lo = 0;
		let hi = cdf.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cdf[mid] < x) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
});

const conceptName = (sub) => {
	while (sub.bare.length) {
		const name = clean(cap(sub.bare.pop()));
		if (claim(name)) return name;
	}
	for (let i = 0; i < 80; i++) {
		const t = pick(sub.terms);
		const u = pick(sub.terms);
		if (t === u) continue;
		const name = clean(pick(CONCEPT_PATTERNS)(t, u));
		if (claim(name)) return name;
	}
	for (let n = 2; ; n++) {
		const name = clean(`${cap(pick(sub.terms))} ${n}`);
		if (claim(name)) return name;
	}
};
const titleFrom = (patterns, sub) => {
	for (let i = 0; i < 80; i++) {
		const name = clean(pick(patterns)(pick(sub.terms), pick(sub.terms)));
		if (claim(name)) return name;
	}
	for (let n = 2; ; n++) {
		const name = clean(`${pick(patterns)(pick(sub.terms), pick(sub.terms))} ${n}`);
		if (claim(name)) return name;
	}
};
const pickSub = (topic) => {
	const total = topic.subs.reduce((a, s) => a + s.weight, 0);
	let x = rand() * total;
	for (const s of topic.subs) if ((x -= s.weight) <= 0) return s;
	return topic.subs[topic.subs.length - 1];
};
const allSubs = TOPICS.flatMap((t) => t.subs);

// ------------------------------------------------------------- people & orgs

const nameQueue = shuffle(FIRST.flatMap((f) => LAST.map((l) => [f, l])));
const freshPersonName = () => {
	while (nameQueue.length) {
		const [first, last] = nameQueue.pop();
		const name = `${first} ${last}`;
		if (!taken.has(name.toLowerCase())) return { first, name };
	}
	fail("Ran out of person names; try a smaller --scale");
};
const makePerson = (group, day, tag, folder = "People") => {
	const { first, name } = freshPersonName();
	claim(name);
	const note = makeNote(name, folder, day, "person", { first, group, heading: chance(0.3) });
	note.fmTags.push(tag);
	group.push(note);
	return note;
};

const orgs = new Map();
const makeOrg = (name, day) => {
	claim(name);
	const note = makeNote(name, "Organizations", day, "org");
	note.fmTags.push("organization");
	orgs.set(name, note);
	return note;
};

const JOBS = [
	{ org: "Northwind Labs", start: 0, end: 505, size: 18 },
	{ org: "Helix Systems", start: 525, end: 1290, size: 30 },
	{ org: "Brightline Health", start: 1310, end: TOTAL_DAYS + 1, size: 26 },
];
JOBS.forEach((job) => {
	job.orgNote = makeOrg(job.org, Math.max(0, job.start - int(5, 30)));
	job.colleagues = [];
	const span = Math.min(job.end, TOTAL_DAYS) - job.start;
	for (let i = 0; i < scaled(job.size); i++)
		makePerson(job.colleagues, job.start + Math.floor(Math.pow(rand(), 2.5) * span), "person/colleague").org =
			job.orgNote;
	// the person you have 1-1s with: a manager, a second one after a reorg
	job.managerAt = (d) =>
		job.colleagues[d - job.start > span * 0.6 && job.colleagues.length > 1 ? 1 : 0];
	job.reportsFrom = job.start + 120;
	job.reports = job.org === "Brightline Health" ? job.colleagues.slice(2, 6) : [];
	// managers and reports get a note in the first days of the job
	job.colleagues.slice(0, 2).concat(job.reports).forEach((p) => {
		p.day = job.start + int(0, 10);
		p.time = timeOn(p.day);
	});
	job.projects = [];
});
OTHER_ORGS.forEach((name) => makeOrg(name, int(0, TOTAL_DAYS - 200)));
const otherOrgs = OTHER_ORGS.map((n) => orgs.get(n));
const jobAt = (d) => JOBS.find((j) => d >= j.start && d < j.end);

const friends = [];
const family = [];
const acquaintances = [];
for (let i = 0; i < scaled(28); i++) {
	const p = makePerson(friends, chance(0.6) ? int(0, 200) : int(0, TOTAL_DAYS), "person/friend");
	if (chance(0.25)) p.org = pick(otherOrgs);
}
for (let i = 0; i < scaled(10); i++) makePerson(family, int(0, 60), "person/family");
for (let i = 0; i < scaled(12); i++) {
	const p = makePerson(acquaintances, int(0, TOTAL_DAYS), "person");
	if (chance(0.5)) p.org = pick(otherOrgs);
}
const existing = (list, d) => list.filter((n) => n.day <= d);

// ----------------------------------------------------------------- projects

const projects = [];
const areaHubs = new Map();
const makeProject = (name, kind, start, end, extra) => {
	const done = end < TOTAL_DAYS - 7;
	const archived = done && end < TOTAL_DAYS - 60 && chance(0.65);
	const folder = `${archived ? "Archive/" : ""}Projects/${name}`;
	const project = { name, kind, start, end, done, folder, subnotes: [], ...extra };
	project.hub = makeNote(name, folder, start, "projectHub", { project, heading: true });
	project.hub.fmTags.push("project", done ? "project/done" : "project/active");
	project.hub.fm.status = done ? "done" : "active";
	projects.push(project);
	return project;
};
JOBS.forEach((job) => {
	const span = Math.min(job.end, TOTAL_DAYS) - job.start;
	const count = scaled(Math.round(span / 65));
	const workTopics = ["software", "ml", "design", "leadership"].map((t) => topicByTag.get(t));
	for (let i = 0; i < count; i++) {
		let name = CODENAMES.find((c) => !taken.has(c.toLowerCase()));
		if (!name) name = `${pick(CODENAMES)} ${int(2, 99)}`;
		if (!claim(name)) continue;
		const start = job.start + int(0, Math.max(1, span - 30));
		const end = Math.min(start + int(30, 320), job.end < TOTAL_DAYS ? job.end : Infinity);
		const subs = [pickSub(skewed(workTopics, 1.5))];
		if (chance(0.5)) subs.push(pickSub(pick(workTopics)));
		const project = makeProject(name, "work", start, end, {
			job,
			subs,
			team: skewedSample(job.colleagues, int(2, 8)),
			org: chance(0.4) ? pick(otherOrgs) : job.orgNote,
		});
		job.projects.push(project);
	}
});
for (let i = 0; i < scaled(18); i++) {
	const [base, tag, area] = PERSONAL_PROJECTS[i % PERSONAL_PROJECTS.length];
	const name = i < PERSONAL_PROJECTS.length ? base : `${base} ${2 + Math.floor(i / PERSONAL_PROJECTS.length)}`;
	if (!claim(name)) continue;
	const year = name.match(/\b(20\d\d)\b/);
	const start = year
		? clampDay(dayOfDate(Number(year[1]), 0, 1) + int(0, 80))
		: int(0, TOTAL_DAYS - 20);
	makeProject(name, "personal", start, start + int(20, 400), {
		subs: [pickSub(topicByTag.get(tag))],
		team: skewedSample(friends.concat(family), int(0, 3)),
		areaName: AREA_ALIASES[area] ?? area,
	});
}
projects.forEach((p) => {
	const last = Math.min(p.end, TOTAL_DAYS);
	const dayIn = () => p.start + Math.floor(Math.pow(rand(), 1.5) * Math.max(1, last - p.start));
	const shared = shuffle((p.kind === "work" ? SHARED_SUBNOTES : PERSONAL_SUBNOTES).slice());
	for (const name of shared.slice(0, int(2, p.kind === "work" ? 9 : 5)))
		p.subnotes.push(makeNote(name, p.folder, dayIn(), "projectNote", { project: p, shared: true }));
	for (let i = int(0, p.kind === "work" ? 5 : 2); i > 0; i--) {
		const name = clean(
			p.kind === "work" ? `${p.name} ${pick(WORK_SPECIFIC)}` : `${p.name} - ${pick(PERSONAL_SPECIFIC)}`
		);
		if (claim(name)) p.subnotes.push(makeNote(name, p.folder, dayIn(), "projectNote", { project: p }));
	}
	p.subnotes.forEach((n) => n.fmTags.push("project"));
	if (chance(0.3)) p.proposal = makeAttachment("Attachments", `${p.name} proposal.pdf`, p.start, "pdf");
});
const activeProjects = (d, kind) =>
	projects.filter((p) => p.start <= d && d <= p.end && (!kind || p.kind === kind));

// ----------------------------------------------------- topic notes & sources

const topicWeight = TOPICS.reduce((a, t) => a + t.weight, 0);
TOPICS.forEach((t) => {
	const count = Math.max(4, Math.round((1700 * opts.scale * t.weight) / topicWeight));
	for (let i = 0; i < count; i++) {
		const sub = pickSub(t);
		const note = makeNote(conceptName(sub), `Notes/${t.name}`, t.sampleDay(), "concept", {
			sub,
			orphan: chance(0.03),
		});
		if (chance(0.7)) note.fmTags.push(`${t.tag}/${sub.tag}`);
		if (chance(0.4)) note.fmTags.push(`status/${pick(["seedling", "budding", "evergreen"])}`);
		if (chance(0.05)) note.inlineTags.push("idea");
		if (chance(0.04)) note.inlineTags.push("question");
		if (chance(0.1)) note.fm.aliases = [note.name.toLowerCase()];
		t.concepts.push(note);
	}
});

const authors = [];
const authorPool = Array.from({ length: scaled(80) }, () => ({ works: [] }));
const showNotes = new Map();
const PAPER_TOPICS = new Set(["software", "ml", "math", "science", "psychology", "economics"]);
TOPICS.forEach((t) => {
	const count = Math.max(2, Math.round((430 * opts.scale * t.weight) / topicWeight));
	for (let i = 0; i < count; i++) {
		const sub = pickSub(t);
		const day = t.sampleDay();
		let r = rand();
		if (r >= 0.3 && r < 0.42 && !PAPER_TOPICS.has(t.tag)) r = 0.5; // papers only where they exist
		let note;
		if (r < 0.3) {
			note = makeNote(titleFrom(BOOK_PATTERNS, sub), "Sources/Books", day, "source", { sub });
			note.fmTags.push("source/book");
			note.author = skewed(authorPool, 1.8);
			if (chance(0.12)) note.inlineTags.push("to-read");
		} else if (r < 0.42) {
			note = makeNote(titleFrom(PAPER_PATTERNS, sub), "Sources/Papers", day, "source", { sub });
			note.fmTags.push("source/paper");
			note.author = skewed(authorPool, 1.8);
			if (chance(0.8))
				note.pdf = makeAttachment(
					"Attachments/Papers",
					`${note.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}.pdf`,
					day,
					"pdf"
				);
		} else if (r < 0.8) {
			note = makeNote(titleFrom(ARTICLE_PATTERNS, sub), "Sources/Articles", day, "source", { sub });
			note.fmTags.push("source/article");
			note.fm.url = `https://example.com/${note.id}`;
			if (chance(0.5)) note.author = skewed(authorPool, 1.8);
		} else if (r < 0.9) {
			const show = skewed(PODCASTS, 1.5);
			let name;
			do name = clean(`${show} ${int(1, 400)} - ${cap(pick(sub.terms))}`);
			while (!claim(name));
			note = makeNote(name, "Sources/Podcasts", day, "source", { sub, showName: show });
			note.fmTags.push("source/podcast");
		} else {
			note = makeNote(titleFrom(VIDEO_PATTERNS, sub), "Sources/Videos", day, "source", { sub });
			note.fmTags.push("source/video");
		}
		if (chance(0.5)) note.fmTags.push(`${t.tag}/${sub.tag}`);
		note.author?.works.push(note);
	}
});
authorPool
	.filter((a) => a.works.length)
	.forEach((a) => {
		const first = a.works.reduce((x, w) => (w.time < x.time ? w : x));
		const note = makePerson(authors, first.day, "person/author", "Sources/Authors");
		note.time = first.time - 60000;
		a.works.forEach((w) => (w.author = note));
	});
notes
	.filter((n) => n.showName)
	.forEach((n) => {
		let show = showNotes.get(n.showName);
		if (!show) {
			claim(n.showName);
			show = makeNote(n.showName, "Sources/Podcasts", n.day, "show", { episodes: [] });
			show.fmTags.push("source/podcast-show");
			showNotes.set(n.showName, show);
		}
		if (n.time < show.time) {
			show.day = n.day;
			show.time = n.time - 60000;
		}
		show.episodes.push(n);
		n.show = show;
	});

// ------------------------------------------------------------------ journal

const dailyByDay = new Map();
const vacations = Array.from({ length: 7 }, () => {
	const s = int(0, TOTAL_DAYS - 20);
	return [s, s + int(5, 18)];
});
for (let d = 0; d <= TOTAL_DAYS; d++) {
	let p = 0.3 + (0.55 * d) / TOTAL_DAYS;
	if (isWeekend(d)) p *= 0.7;
	if (vacations.some(([a, b]) => d >= a && d <= b)) p = 0.08;
	if (!chance(p)) continue;
	claim(ymd(d));
	const note = makeNote(ymd(d), `Daily/${yearOf(d)}`, d, "daily", { time: timeOn(d, 6, 10), heading: false });
	note.fmTags.push("journal/daily");
	if (chance(0.25)) note.inlineTags.push(`mood/${pick(MOODS)}`);
	dailyByDay.set(d, note);
}
const weeklyByName = new Map();
for (let d = 200; d + 6 <= TOTAL_DAYS; d += 7) {
	if (!chance(0.68)) continue;
	const name = isoWeek(d);
	claim(name);
	const note = makeNote(name, "Reviews/Weekly", d + 6, "weekly", { weekStart: d, heading: true });
	note.fmTags.push("review/weekly");
	weeklyByName.set(name, note);
}
const monthlyByName = new Map();
for (let y = 2022; y <= 2026; y++)
	for (let m = 0; m < 12; m++) {
		const first = dayOfDate(y, m, 1);
		const last = dayOfDate(y, m + 1, 1) - 1;
		if (first < 120 || last > TOTAL_DAYS || !chance(0.85)) continue;
		const name = `${y}-${String(m + 1).padStart(2, "0")}`;
		claim(name);
		const note = makeNote(name, "Reviews/Monthly", last, "monthly", { first, last, heading: true });
		note.fmTags.push("review/monthly");
		monthlyByName.set(name, note);
	}
const yearly = [2022, 2023, 2024, 2025].map((y) => {
	const name = `${y} Review`;
	claim(name);
	const note = makeNote(name, "Reviews/Yearly", dayOfDate(y, 11, 30), "yearly", { year: y, heading: true });
	note.fmTags.push("review/yearly");
	return note;
});

// ----------------------------------------------------------------- meetings

const meetingsByDay = new Map();
const seriesNotes = new Map();
const addMeeting = (d, title, extra) => {
	let name = clean(`${ymd(d)} ${title}`);
	for (let n = 2; !claim(name); n++) name = clean(`${ymd(d)} ${title} ${n}`);
	const note = makeNote(name, `Meetings/${yearOf(d)}`, d, "meeting", {
		time: timeOn(d, 9, 18),
		heading: chance(0.4),
		...extra,
	});
	note.fmTags.push(extra.tag ?? "meeting");
	if (!meetingsByDay.has(d)) meetingsByDay.set(d, []);
	meetingsByDay.get(d).push(note);
	return note;
};
for (let d = 0; d <= TOTAL_DAYS; d++) {
	const job = jobAt(d);
	if (!job || isWeekend(d)) continue;
	for (let i = poisson(0.5 * opts.scale); i > 0; i--) {
		const r = rand();
		const active = job.projects.filter((p) => p.start <= d && d <= p.end);
		if (r < 0.32) {
			const toReport = job.reports.length && d > job.reportsFrom && chance(0.5);
			const person = toReport ? skewed(job.reports, 1.5) : job.managerAt(d);
			addMeeting(d, `1-1 with ${person.first}`, { people: [person], tag: "meeting/1-1" });
		} else if (r < 0.72 && active.length) {
			const p = pick(active);
			let kind = pick(["sync", "planning", "design review", "standup notes", "demo"]);
			if (!p.kickoff && d - p.start < 21) kind = p.kickoff = "kickoff";
			else if (!p.retro && p.done && p.end - d < 20) kind = p.retro = "retro";
			addMeeting(d, `${p.name} ${kind}`, { project: p, people: skewedSample(p.team, int(1, 5)) });
		} else if (r < 0.84) {
			let series = seriesNotes.get(job);
			if (!series) {
				const name = `${job.org} team sync`;
				claim(name);
				series = makeNote(name, "Meetings/Series", d, "series", { job, heading: true });
				series.fmTags.push("meeting/series");
				seriesNotes.set(job, series);
			}
			addMeeting(d, "Team sync", {
				series,
				people: skewedSample(existing(job.colleagues, d), int(3, 7)),
			});
		} else if (r < 0.92) {
			const candidate = freshPersonName();
			addMeeting(d, `Interview - ${candidate.name}`, {
				candidate: chance(0.25) ? candidate.name : null,
				people: skewedSample(existing(job.colleagues, d), int(1, 2)),
				tag: "meeting/interview",
			});
		} else {
			const person = skewed(existing(job.colleagues, d).concat(job.managerAt(d)));
			const title = pick(["All hands", "Offsite planning", "Quarterly planning", "Incident review", `Coffee with ${person.first}`]);
			addMeeting(d, title, { people: title.startsWith("Coffee") ? [person] : [] });
		}
	}
}

// ------------------------------------------------- areas, inbox and the rest

AREAS.forEach((area) => {
	claim(area.name);
	const hub = makeNote(area.name, "Areas", int(0, 40), "areaHub", { area, heading: true });
	hub.fmTags.push(`area/${area.name.toLowerCase().replace(/ /g, "-")}`);
	areaHubs.set(area.name, hub);
	area.hub = hub;
	area.notes = area.notes
		.filter((name) => claim(name))
		.map((name) => {
			const year = name.match(/\b(20\d\d)\b/);
			const day = year ? clampDay(dayOfDate(Number(year[1]), 0, int(1, 60))) : int(0, TOTAL_DAYS - 30);
			return makeNote(name, `Areas/${area.name}`, day, "areaNote", { area });
		});
});
projects
	.filter((p) => p.areaName)
	.forEach((p) => (p.area = areaHubs.get(p.areaName)));

const INBOX_PATTERNS = [
	(s) => `Idea - ${pick(s.terms)}`,
	(s) => `Thought on ${pick(s.terms)}`,
	(s) => `Look into ${pick(s.terms)}`,
	(s) => `Question about ${pick(s.terms)}`,
	() => `Follow up with ${pick(FIRST)}`,
	() => `Book rec from ${pick(FIRST)}`,
];
for (let i = 0; i < scaled(160); i++) {
	let name;
	if (i < 7) name = i === 0 ? "Untitled" : `Untitled ${i}`;
	else name = clean(pick(INBOX_PATTERNS)(pick(allSubs)));
	if (!claim(name)) continue;
	const day = chance(0.8) ? int(TOTAL_DAYS - 150, TOTAL_DAYS) : int(0, TOTAL_DAYS);
	const note = makeNote(name, "Inbox", day, "inbox", { empty: i === 0, heading: false });
	if (chance(0.3)) note.fmTags.push("inbox");
}
for (let i = 0; i < scaled(120); i++) {
	const sub = pick(allSubs);
	const note = makeNote(titleFrom(ARTICLE_PATTERNS, sub), "Clippings", sub.topic.sampleDay(), "clipping", { sub });
	note.fmTags.push("clippings");
	note.fm.source = `https://example.org/clip/${note.id}`;
}

claim("🏠 Home");
const home = makeNote("🏠 Home", "", 0, "hub", { heading: true });
claim("Projects dashboard");
const dashboard = makeNote("Projects dashboard", "", 3, "hub", { heading: true });
claim("Dashboard");
const dataview = makeNote("Dashboard", "", 30, "hub", { heading: true });
dataview.text = '```dataview\nTABLE file.ctime AS Created FROM "Notes" SORT file.ctime DESC LIMIT 20\n```';

const TEMPLATES = [
	["Daily note template", ['<< [[<% tp.date.yesterday("YYYY-MM-DD") %>]] | [[<% tp.date.tomorrow("YYYY-MM-DD") %>]] >>'], true],
	["Meeting template", ['date:: [[<% tp.file.creation_date("YYYY-MM-DD") %>]]', "attendees::"], false],
	["Book template", ["author:: [[{{author}}]]"], false],
	["Person template", ["company::"], false],
	["Project template", ["status:: active", "area::"], true],
	["Weekly review template", ['[[<% tp.date.weekday("YYYY-[W]ww", 0) %>]]'], true],
	["Concept template", ["up:: "], false],
];
const templates = TEMPLATES.map(([name, lines, linksHome]) => {
	claim(name);
	const note = makeNote(name, "Templates", int(0, 200), "template", { heading: false, templateLines: lines });
	if (linksHome) link(note, home, "body");
	return note;
});

// ----------------------------------------------- replay the vault's history
// Notes link mostly to notes that already exist when they're written.

const conceptsByDay = new Map();
const sourcesByDay = new Map();
const pushDay = (map, d, note) => {
	if (!map.has(d)) map.set(d, []);
	map.get(d).push(note);
};
const dailyOr = (d) => dailyByDay.get(d) ?? unresolved(ymd(d));
const unresolvedIn = (sub) => {
	if (sub.unresolved.length && chance(0.45)) return pick(sub.unresolved);
	const u = unresolved(conceptName(sub)); // claimed, so no real note takes the name later
	sub.unresolved.push(u);
	return u;
};
const conceptFromTopics = (from, topicTags, place) => {
	const t = topicByTag.get(pick(topicTags));
	return linkFromPool(from, pickSub(t).concepts, place);
};

const linkers = {
	concept(n) {
		const s = n.sub;
		const t = s.topic;
		if (!n.orphan) {
			for (let i = linkCount(3.4); i > 0; i--) {
				const place = chance(0.72) ? "body" : "list:Related";
				const r = rand();
				if (r < 0.56) linkFromPool(n, s.concepts, place);
				else if (r < 0.76) linkFromPool(n, pick(t.subs).concepts, place);
				else if (r < 0.88) {
					// a bridge to another topic, usually a neighboring one
					const other = chance(0.65) ? pick(t.related) : pick(TOPICS);
					linkFromPool(n, pickSub(other).concepts, place);
				} else if (r < 0.94) link(n, unresolvedIn(s), place);
				else linkFromPool(n, s.sources, place);
			}
			if (chance(0.3)) linkFromPool(n, s.sources, chance(0.4) ? "fm:source" : "list:Sources");
			if (chance(0.07)) link(n, pastedImage(n.day, n.time + 120000), "embed");
			if (chance(0.08)) {
				const p = pick(activeProjects(n.day).filter((p) => p.subs.includes(s)));
				if (p) link(n, p.hub, "body");
			}
			s.concepts.items.push(n);
		}
		s.all.push(n);
		pushDay(conceptsByDay, n.day, n);
	},
	source(n) {
		const s = n.sub;
		if (n.author) link(n, n.author, "fm:author");
		if (n.show) link(n, n.show, "fm:show");
		for (let i = int(0, 3); i > 0; i--) linkFromPool(n, s.concepts, "list:Key ideas");
		if (chance(0.15)) linkFromPool(n, s.sources, "body");
		if (n.pdf) link(n, n.pdf, "embed");
		s.sources.items.push(n);
		s.allSources.push(n);
		pushDay(sourcesByDay, n.day, n);
	},
	person(n) {
		if (n.org) link(n, n.org, "fm:company");
		if (chance(0.1)) {
			const other = pick(existing(n.group, n.day).filter((p) => p !== n));
			if (other) link(n, other, "body");
		}
	},
	meeting(n) {
		if (chance(0.6)) link(n, dailyOr(n.day), "field:date");
		else n.fm.date = ymd(n.day);
		n.people.forEach((p) => link(n, p, "list:Attendees"));
		if (n.candidate) link(n, unresolved(n.candidate), "body");
		if (n.series) link(n, n.series, "fm:series");
		if (n.project) {
			link(n, n.project.hub, chance(0.6) ? "fm:project" : "body");
			if (chance(0.3)) {
				const sub = pick(n.project.subnotes.filter((s) => s.day <= n.day));
				if (sub) link(n, sub, "list:Action items");
			}
			if (chance(0.15)) linkFromPool(n, pick(n.project.subs).concepts, "body");
		}
		if (chance(0.04)) link(n, pastedImage(n.day, n.time + 600000), "embed");
	},
	projectNote(n) {
		const p = n.project;
		link(n, p.hub, chance(0.75) ? "fm:up" : "body");
		for (let i = int(0, 2); i > 0; i--) {
			const sibling = pick(p.subnotes.filter((s) => s.day <= n.day && s !== n));
			if (sibling) link(n, sibling, "body");
		}
		skewedSample(p.team, int(0, 3)).forEach((person) => link(n, person, "body"));
		for (let i = int(0, 3); i > 0; i--) linkFromPool(n, pick(p.subs).concepts, "list:Related");
		if (chance(0.1)) {
			const name = clean(`${p.name} ${pick(WORK_SPECIFIC)}`);
			if (claim(name)) link(n, unresolved(name), "body");
		}
		if (chance(0.15)) link(n, pastedImage(n.day, n.time + 300000), "embed");
		if (p.proposal && chance(0.2)) link(n, p.proposal, "body");
	},
	areaNote(n) {
		link(n, n.area.hub, chance(0.8) ? "fm:up" : "body");
		for (let i = int(0, 2); i > 0; i--) conceptFromTopics(n, n.area.topics, "list:Related");
		activeProjects(n.day, "personal")
			.filter((p) => p.area === n.area.hub)
			.slice(0, 2)
			.forEach((p) => link(n, p.hub, "body"));
	},
	inbox(n) {
		if (chance(0.35)) return; // never processed
		for (let i = int(1, 2); i > 0; i--) {
			const r = rand();
			if (r < 0.6) linkFromPool(n, pick(allSubs).concepts, "body");
			else if (r < 0.8) link(n, pick(friends.concat(family)), "body");
			else {
				const p = pick(activeProjects(n.day));
				if (p) link(n, p.hub, "body");
			}
		}
	},
	clipping(n) {
		if (chance(0.4)) linkFromPool(n, n.sub.concepts, "body");
	},
};
notes
	.filter((n) => linkers[n.kind])
	.sort((a, b) => a.time - b.time)
	.forEach((n) => linkers[n.kind](n));

// ---------------------------------------------- notes kept up to date by hand

// daily notes link whatever happened that day. For a while their template
// linked yesterday and tomorrow, which may have no note; later a plugin
// linked the previous and next daily notes that exist.
const NAV_FROM = 150;
const NAV_EXISTING_FROM = 650;
const WEEKLY_FROM = 200;
const dailyDays = [...dailyByDay.keys()];
dailyDays.forEach((d, i) => {
	const n = dailyByDay.get(d);
	if (d >= NAV_EXISTING_FROM) {
		if (i > 0) link(n, dailyByDay.get(dailyDays[i - 1]), "nav");
		if (i < dailyDays.length - 1) link(n, dailyByDay.get(dailyDays[i + 1]), "nav");
	} else if (d >= NAV_FROM) {
		link(n, dailyOr(d - 1), "nav");
		link(n, dailyOr(d + 1), "nav");
	}
	if (d >= WEEKLY_FROM) link(n, weeklyByName.get(isoWeek(d)) ?? unresolved(isoWeek(d)), "field:week");
	(meetingsByDay.get(d) ?? []).forEach((m) => chance(0.6) && link(n, m, "list:Meetings"));
	(conceptsByDay.get(d) ?? []).slice(0, 5).forEach((c) => chance(0.4) && link(n, c, "list:Created today"));
	(sourcesByDay.get(d) ?? []).forEach((s) => chance(0.5) && link(n, s, "body"));
	const active = activeProjects(d);
	for (let i = poisson(0.5); i > 0 && active.length; i--) link(n, pick(active).hub, "body");
	const job = jobAt(d);
	const people = existing(friends.concat(family, job && !isWeekend(d) ? job.colleagues : []), d);
	for (let i = poisson(0.5); i > 0 && people.length; i--) link(n, skewed(people), "body");
	if (chance(0.08)) linkFromPool(n, pick(allSubs).concepts, "body");
	if (chance(0.04)) link(n, pick([...areaHubs.values()]), "body");
	if (chance(0.06)) link(n, pastedImage(d, n.time + int(1, 14) * 3600000), "embed");
});

const previousOf = (map, name) => {
	const keys = [...map.keys()];
	const i = keys.indexOf(name);
	return i > 0 ? map.get(keys[i - 1]) : null;
};
weeklyByName.forEach((n, name) => {
	for (let d = n.weekStart; d < n.weekStart + 7; d++) if (dailyByDay.has(d)) link(n, dailyByDay.get(d), "list:Days");
	const prev = previousOf(weeklyByName, name);
	if (prev) link(n, prev, "nav");
	const month = ymd(n.day).slice(0, 7);
	link(n, monthlyByName.get(month) ?? unresolved(month), "field:month");
	skewedSample(activeProjects(n.day), int(1, 4), 1).forEach((p) => link(n, p.hub, "list:Projects"));
	for (let d = n.weekStart; d < n.weekStart + 7; d++)
		(conceptsByDay.get(d) ?? []).forEach((c) => chance(0.15) && link(n, c, "list:New notes"));
});
monthlyByName.forEach((n, name) => {
	weeklyByName.forEach((w, wName) => ymd(w.weekStart).startsWith(name) && link(n, w, "list:Weeks"));
	const prev = previousOf(monthlyByName, name);
	if (prev) link(n, prev, "nav");
	activeProjects(n.day).forEach((p) => chance(0.7) && link(n, p.hub, "list:Projects"));
	const goals = notes.find((g) => g.kind === "areaNote" && g.name === `${name.slice(0, 4)} Goals`);
	if (goals) link(n, goals, "fm:goals");
	skewedSample([...areaHubs.values()], int(0, 3), 1).forEach((a) => link(n, a, "body"));
});
yearly.forEach((n) => {
	monthlyByName.forEach((m, name) => name.startsWith(String(n.year)) && link(n, m, "list:Months"));
	const goals = notes.find((g) => g.name === `${n.year} Goals`);
	if (goals) link(n, goals, "fm:goals");
	projects
		.filter((p) => yearOf(Math.min(p.end, TOTAL_DAYS)) === n.year && p.done)
		.forEach((p) => link(n, p.hub, "list:Shipped"));
});

// maps of content: a topic gets one once it has a dozen notes, a big
// subtopic gets its own; most notes point "up" to the closest one
const mocs = [];
const SUB_MOC_SIZE = 60;
TOPICS.forEach((t) => {
	const concepts = t.subs.flatMap((s) => s.all).sort((a, b) => a.time - b.time);
	if (concepts.length < 12) return;
	const moc = makeNote(t.mocName, "Maps", concepts[11].day, "moc", { heading: true });
	moc.time = concepts[11].time + 3600000;
	moc.fmTags.push("moc");
	t.moc = moc;
	mocs.push(moc);
	t.subs.forEach((s) => {
		if (s.all.length >= SUB_MOC_SIZE) {
			const sorted = s.all.slice().sort((a, b) => a.time - b.time);
			s.moc = makeNote(s.mocName, "Maps", sorted[SUB_MOC_SIZE - 1].day, "moc", { heading: true });
			s.moc.time = sorted[SUB_MOC_SIZE - 1].time + 3600000;
			s.moc.fmTags.push("moc");
			mocs.push(s.moc);
			link(s.moc, moc, "fm:up");
			link(moc, s.moc, `list:${s.name}`);
			s.all.forEach((c) => !c.orphan && chance(0.9) && link(s.moc, c, "list:Notes"));
			s.allSources.forEach((src) => chance(0.3) && link(s.moc, src, "list:Sources"));
		} else s.all.forEach((c) => !c.orphan && chance(0.85) && link(moc, c, `list:${s.name}`));
		s.allSources.forEach((src) => chance(0.2) && link(moc, src, "list:Sources"));
	});
	t.related.forEach((r) => chance(0.5) && r.moc && link(moc, r.moc, "list:See also"));
});
TOPICS.forEach((t) =>
	t.subs.forEach((s) =>
		s.all.forEach((c) => {
			const up = s.moc ?? t.moc;
			if (up && !c.orphan && chance(0.45)) link(c, up, chance(0.6) ? "fm:up" : "field:up");
		})
	)
);
// a few MOCs were created before the topic notes they list, but every map
// exists before the home note was last edited
mocs.forEach((m) => m.time > END_TIME && (m.time = END_TIME - DAY));

projects.forEach((p) => {
	const hub = p.hub;
	p.subnotes.forEach((s) => link(hub, s, "list:Notes"));
	p.team.forEach((person) => link(hub, person, "list:People"));
	if (p.org) link(hub, p.org, "fm:client");
	if (p.area) link(hub, p.area, "fm:area");
	for (let i = int(1, 3); i > 0; i--) linkFromPool(hub, pick(p.subs).concepts, "list:Related");
	if (p.proposal) link(hub, p.proposal, "embed");
	link(dashboard, hub, p.done ? "list:Done" : "list:Active");
});
seriesNotes.forEach((s) => link(s, s.job.orgNote, "fm:company"));
showNotes.forEach((show) => show.episodes.forEach((e) => chance(0.5) && link(show, e, "list:Episodes")));

// hand-maintained hub notes in the areas
const areaNote = (name) => notes.find((n) => n.kind === "areaNote" && n.name === name);
const books = notes.filter((n) => n.fmTags.includes("source/book"));
const linkAll = (from, list, place, p = 1) => from && list.forEach((x) => chance(p) && link(from, x, place));
linkAll(areaNote("Reading list"), books, "list:Books", 0.6);
["The Pragmatic Gardener", "Notes on a Quiet Mind", "The Map Is Not the Territory"].forEach((t) =>
	link(areaNote("Reading list"), unresolved(t), "list:Want to read")
);
linkAll(areaNote("Brag document"), projects.filter((p) => p.kind === "work"), "list:Projects", 0.8);
linkAll(areaNote("Birthdays"), friends.concat(family), "list:People");
linkAll(areaNote("Gift ideas"), family.concat(friends.slice(0, 8)), "body", 0.7);
linkAll(areaNote("Family tree"), family, "list:Family");
linkAll(areaNote("Travel log"), topicByTag.get("travel").subs[0].all, "list:Trips", 0.8);
linkAll(areaNote("Bucket list"), topicByTag.get("travel").subs[0].all, "list:Places", 0.5);
["Kyoto in autumn", "the Northern Lights", "Tasmania", "the Camino de Santiago"].forEach((t) =>
	link(areaNote("Bucket list"), unresolved(cap(t)), "list:Someday")
);
linkAll(areaNote("Conference talks"), notes.filter((n) => n.fmTags.includes("source/video")), "list:Talks", 0.5);
linkAll(areaNote("Newsletter issues"), topicByTag.get("writing").concepts, "list:Issues", 0.25);
linkAll(areaNote("Job search 2023"), [orgs.get("Helix Systems"), ...otherOrgs.slice(0, 4)], "list:Companies");
link(areaNote("Job search 2023"), areaNote("Interview prep"), "body");
link(areaNote("Job search 2023"), areaNote("Resume"), "body");
["Coursera - Machine Learning", "Rust in Action workshop", "Watercolor basics"].forEach((t) =>
	link(areaNote("Courses"), unresolved(t), "list:Courses")
);
const manuals = ["Dishwasher", "Furnace", "Water heater", "Washing machine", "Dryer", "Refrigerator", "Thermostat", "Garage door opener", "Range hood", "Router"]
	.map((a) => makeAttachment("Attachments/Manuals", `${a} manual.pdf`, int(0, 400), "pdf"));
linkAll(areaNote("Appliance manuals"), manuals, "embed");
[2023, 2024, 2025].forEach((y) =>
	link(areaNote("Bloodwork results"), makeAttachment("Attachments/Health", `Bloodwork ${y}.pdf`, dayOfDate(y, 2, 10), "pdf"), "body")
);
for (let y = 2022; y <= 2026; y++) {
	const goals = areaNote(`${y} Goals`);
	activeProjects(dayOfDate(y, 6, 1)).forEach((p) => chance(0.5) && link(goals, p.hub, "list:Projects"));
	skewedSample([...areaHubs.values()], int(2, 5), 1).forEach((a) => link(goals, a, "list:Areas"));
	if (y > 2022) link(goals, areaNote(`${y - 1} Goals`), "body");
}
AREAS.forEach((a) => {
	a.notes.forEach((n) => link(a.hub, n, "list:Notes"));
	projects.filter((p) => p.area === a.hub).forEach((p) => link(a.hub, p.hub, "list:Projects"));
});

mocs.forEach((m) => link(home, m, "list:Maps"));
areaHubs.forEach((a) => link(home, a, "list:Areas"));
[dashboard, dataview, areaNote("2026 Goals"), areaNote("Reading list"), [...weeklyByName.values()].pop()].forEach(
	(n) => n && link(home, n, "list:Start here")
);
link(dataview, dashboard, "body");
link(dataview, home, "body");

// the same diagram embedded in several notes
DIAGRAMS.forEach(([name, tag]) => {
	const t = topicByTag.get(tag);
	const embedders = skewedSample(t.concepts.filter((c) => !c.orphan), int(3, 14), 1);
	if (!embedders.length) return;
	const first = embedders.reduce((a, b) => (a.time < b.time ? a : b));
	const att = makeAttachment("Attachments/Diagrams", `${name}.svg`, first.day, "svg");
	att.time = first.time;
	embedders.forEach((n) => link(n, att, "embed"));
});
// attachments nothing links to any more
for (let i = 0; i < scaled(25); i++) pastedImage(int(0, TOTAL_DAYS));
for (let i = 0; i < 5; i++) {
	const d = int(0, TOTAL_DAYS);
	makeAttachment("Attachments", `Screenshot ${ymd(d)} at ${int(10, 23)}.${String(int(0, 59)).padStart(2, "0")}.png`, d, "png");
}

// mutual links: going back to an older note to link the new one
const conceptLinks = [];
notes
	.filter((n) => n.kind === "concept")
	.forEach((n) => n.out.forEach((l) => l.to.kind === "concept" && conceptLinks.push([n, l.to])));
conceptLinks.forEach(([a, b]) => chance(0.22) && link(b, a, "list:Related"));
// and a few links to notes written later
TOPICS.forEach((t) =>
	t.subs.forEach((s) =>
		s.all.forEach((n) => {
			if (n.orphan || !chance(0.06)) return;
			const later = s.all.filter((x) => x.time > n.time && !x.orphan);
			for (let i = int(1, 2); i > 0 && later.length; i--) link(n, pick(later), "list:Related");
		})
	)
);

// edge cases: self links, links inside code (which Obsidian ignores), a
// very long name, a note embedded in others
const concepts = notes.filter((n) => n.kind === "concept" && !n.orphan);
for (let i = 0; i < 5; i++) {
	const n = pick(concepts);
	n.out.push({ to: n, place: "body" });
}
topicByTag
	.get("software")
	.concepts.slice(0, 10)
	.forEach((n) => (n.codeBlock = "```ts\n// [[Not a link]] because it's code\nconst wiki = \"[[Also not a link]]\";\n```"));
const longName = clean(
	"A very long note title that keeps going because sometimes a thought does not fit in a few words and the title ends up being the whole idea"
);
claim(longName);
const longNote = makeNote(longName, "Notes", int(300, TOTAL_DAYS), "concept", { sub: pick(allSubs) });
linkFromPool(longNote, longNote.sub.concepts, "body");
link(pick(concepts), longNote, "body");
const transcluded = pick(concepts);
skewedSample(concepts, 6, 1).forEach((n) => n !== transcluded && link(n, transcluded, "embed"));

// --------------------------------------------------------------- rendering

const noteTarget = (t) => (t.shared ? t.path.replace(/\.md$/, "") : t.name);
const plainLink = (l) => {
	const t = l.to;
	if (t.unresolved) return `[[${t.unresolved}]]`;
	if (t.isAttachment) return `[[${t.name}]]`;
	return t.shared ? `[[${noteTarget(t)}|${t.name}]]` : `[[${t.name}]]`;
};
const alias = (name) => name.toLowerCase().split(" ").slice(0, int(1, 3)).join(" ");
const variedLink = (l) => {
	const t = l.to;
	if (t.unresolved) return `[[${t.unresolved}]]`;
	if (t.isAttachment) return l.place === "embed" ? `![[${t.name}${t.kind === "png" && chance(0.2) ? "|400" : ""}]]` : `[[${t.name}]]`;
	const target = noteTarget(t);
	if (l.place === "embed") return `![[${target}${chance(0.5) ? `#${pick(HEADINGS)}` : ""}]]`;
	const r = rand();
	if (r < 0.03) return `[${t.name}](${encodeURI(t.path).replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
	if (r < 0.05 && !t.shared) return `[[${t.name.toLowerCase()}]]`;
	if (r < 0.12) return `[[${target}|${alias(t.name)}]]`;
	if (r < 0.17) return `[[${target}#${pick(HEADINGS)}]]`;
	if (r < 0.19) return `[[${target}#^${Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0")}]]`;
	return plainLink(l);
};
const paragraph = (links) => {
	const words = Array.from({ length: int(14, 40) + links.length * 3 }, () => pick(LOREM));
	links.forEach((l) => words.splice(int(1, words.length), 0, variedLink(l)));
	return `${cap(words.join(" "))}.`;
};
const yamlTags = (tags) => {
	const r = rand();
	if (tags.length === 1 && r < 0.3) return `tags: ${tags[0]}`;
	if (r < 0.5) return `tags: [${tags.join(", ")}]`;
	return `tags:\n${tags.map((t) => `  - ${t}`).join("\n")}`;
};

const render = (n) => {
	if (n.empty) return "";
	const groups = new Map();
	n.out.forEach((l) => {
		if (!groups.has(l.place)) groups.set(l.place, []);
		groups.get(l.place).push(l);
	});

	const fm = [];
	if (n.kind !== "template" && chance(0.85)) fm.push(`created: ${localStamp(n.time)}`);
	Object.entries(n.fm).forEach(([k, v]) =>
		fm.push(Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`)
	);
	if (n.fmTags.length) fm.push(yamlTags(n.fmTags));
	groups.forEach((links, place) => {
		if (!place.startsWith("fm:")) return;
		const key = place.slice(3);
		if (links.length === 1) fm.push(`${key}: "${plainLink(links[0])}"`);
		else fm.push(`${key}:\n${links.map((l) => `  - "${plainLink(l)}"`).join("\n")}`);
	});

	const body = [];
	if (n.heading) body.push(`# ${n.name}`, "");
	if (groups.has("nav")) body.push(groups.get("nav").map(plainLink).join(" | "), "");
	groups.forEach((links, place) => {
		if (place.startsWith("field:")) body.push(`${place.slice(6)}:: ${links.map(plainLink).join(", ")}`);
	});
	if ([...groups.keys()].some((p) => p.startsWith("field:"))) body.push("");
	if (n.templateLines) body.push(...n.templateLines, "");
	if (n.text) body.push(n.text, "");

	const inline = groups.get("body") ?? [];
	const embeds = groups.get("embed") ?? [];
	const paragraphs = Array.from({ length: Math.min(4, Math.ceil(inline.length / 3) + int(0, 1)) || 1 }, () => []);
	inline.forEach((l, i) => paragraphs[i % paragraphs.length].push(l));
	paragraphs.forEach((links, i) => {
		body.push(paragraph(links), "");
		if (i === 0) embeds.forEach((l) => body.push(variedLink(l), ""));
	});
	if (n.codeBlock) body.push(n.codeBlock, "");
	groups.forEach((links, place) => {
		if (!place.startsWith("list:")) return;
		body.push(`## ${place.slice(5)}`, ...links.map((l) => `- ${chance(0.7) ? plainLink(l) : variedLink(l)}`), "");
	});
	if (n.inlineTags.length) body.push(n.inlineTags.map((t) => `#${t}`).join(" "), "");

	const text = body.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
	return fm.length ? `---\n${fm.join("\n")}\n---\n\n${text}` : text;
};

// small but valid attachment files
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
};
const png = (r, g, b) => {
	const size = 16;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolor
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
};
const PNGS = [png(91, 141, 239), png(224, 163, 58), png(79, 178, 134), png(181, 126, 220)];
const pdf = (title) => {
	const text = `BT /F1 18 Tf 40 140 Td (${title.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, "?")}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = objects.map((o, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	offsets.forEach((o) => (out += `${String(o).padStart(10, "0")} 00000 n \n`));
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
};
const svg = (title) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect x="10" y="10" width="300" height="140" rx="12" fill="none" stroke="#888" stroke-width="2"/><text x="160" y="86" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#888">${title}</text></svg>\n`;

const canvases = [];
const canvas = (name, members) => {
	const nodes = members.filter(Boolean).map((n, i) => ({
		id: `node${i}`,
		type: "file",
		file: n.path,
		x: (i % 4) * 460,
		y: Math.floor(i / 4) * 320,
		width: 400,
		height: 260,
	}));
	const edges = nodes.slice(1).map((n, i) => ({ id: `edge${i}`, fromNode: nodes[0].id, fromSide: "right", toNode: n.id, toSide: "left" }));
	canvases.push({ path: `Canvas/${name}.canvas`, data: JSON.stringify({ nodes, edges }, null, "\t"), time: END_TIME - int(1, 200) * DAY });
};
canvas("Topic map", mocs.slice(0, 12));
canvas("Reading map", books.slice(0, 10));
canvas("Life areas", [...areaHubs.values()]);
projects
	.filter((p) => p.kind === "work" && p.subnotes.length > 3)
	.slice(0, 3)
	.forEach((p) => canvas(`${p.name} board`, [p.hub, ...p.subnotes]));

// --------------------------------------------------------------- write it

const out = opts.out;
if (out === path.parse(out).root || out === repoRoot) fail(`Refusing to write the vault to ${out}`);
if (fs.existsSync(out)) {
	const entries = fs.readdirSync(out);
	if (entries.length && !entries.includes(MARKER))
		fail(`${out} already exists and wasn't made by this script, so it won't be overwritten.`);
	entries.filter((e) => e !== ".obsidian").forEach((e) => fs.rmSync(path.join(out, e), { recursive: true, force: true }));
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, MARKER), "Made by scripts/generate-test-vault.mjs. Re-running it replaces everything here except .obsidian.\n");

const dirs = new Set();
const writeFile = (rel, data, created, modified) => {
	const full = path.join(out, rel);
	const dir = path.dirname(full);
	if (!dirs.has(dir)) {
		fs.mkdirSync(dir, { recursive: true });
		dirs.add(dir);
	}
	fs.writeFileSync(full, data);
	// on macOS, moving the modified time earlier than the birth time moves
	// the birth time too, and Obsidian reads a file's creation time from it
	const c = new Date(Math.min(created, END_TIME));
	fs.utimesSync(full, c, c);
	const m = new Date(Math.min(Math.max(modified, created), END_TIME));
	fs.utimesSync(full, m, m);
};

const LONG_LIVED = new Set(["hub", "moc", "projectHub", "areaHub", "series", "show"]);
notes.forEach((n) => {
	const modified = LONG_LIVED.has(n.kind)
		? END_TIME - int(0, 30) * DAY
		: n.kind === "daily"
		? n.time + int(1, 14) * 3600000
		: n.time - Math.log(1 - rand()) * 20 * DAY;
	writeFile(n.path, render(n), n.time, modified);
});
attachments.forEach((a, i) => {
	const data =
		a.kind === "png" ? PNGS[i % PNGS.length] : a.kind === "svg" ? svg(a.name.replace(/\.svg$/, "")) : pdf(a.name.replace(/\.pdf$/, ""));
	writeFile(a.path, data, a.time, a.time);
});
canvases.forEach((c) => writeFile(c.path, c.data, c.time, c.time));

// ------------------------------------------------------------- the plugin

let pluginNote = "skipped (--no-plugin)";
if (opts.plugin) {
	const obsidianDir = path.join(out, ".obsidian");
	const pluginDir = path.join(obsidianDir, "plugins", "3d-graph");
	const built = ["main.js", "manifest.json", "styles.css"];
	if (built.every((f) => fs.existsSync(path.join(repoRoot, f)))) {
		fs.mkdirSync(pluginDir, { recursive: true });
		built.forEach((f) => fs.copyFileSync(path.join(repoRoot, f), path.join(pluginDir, f)));
		const enabled = path.join(obsidianDir, "community-plugins.json");
		if (!fs.existsSync(enabled)) fs.writeFileSync(enabled, JSON.stringify(["3d-graph"], null, 2));
		pluginNote = `installed from ${path.relative(process.cwd(), repoRoot) || "."}/main.js`;
	} else pluginNote = "not installed: run `npm run build` first";
}

// -------------------------------------------------------------- stats

const nodeKey = (t) => (t.unresolved ? `unresolved:${t.unresolved}` : t.path);
const pairs = new Map();
const degree = new Map();
const tags = new Set();
const unresolvedTargets = new Set();
let resolvedLinkCount = 0;
notes.forEach((n) => {
	n.fmTags.concat(n.inlineTags).forEach((t) => tags.add(t));
	n.out.forEach((l) => {
		if (l.to === n) return;
		if (l.to.unresolved) unresolvedTargets.add(l.to.unresolved);
		else resolvedLinkCount++;
		const [a, b] = [n.path, nodeKey(l.to)];
		const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
		if (pairs.has(key)) {
			pairs.set(key, "mutual");
			return;
		}
		pairs.set(key, "one-way");
		degree.set(a, (degree.get(a) ?? 0) + 1);
		degree.set(b, (degree.get(b) ?? 0) + 1);
	});
});
const orphanNotes = notes.filter((n) => !degree.get(n.path)).length;
const mutual = [...pairs.values()].filter((v) => v === "mutual").length;
const kinds = {};
notes.forEach((n) => (kinds[n.kind] = (kinds[n.kind] ?? 0) + 1));
const hubs = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const fmt = (n) => n.toLocaleString("en-US");

console.log(`Test vault written to ${out}

  notes          ${fmt(notes.length)}
  attachments    ${fmt(attachments.length + canvases.length)}
  tags           ${fmt(tags.size)}
  unresolved     ${fmt(unresolvedTargets.size)} link targets with no note
  links          ${fmt(pairs.size)} connected pairs (${fmt(mutual)} mutual), ${fmt(resolvedLinkCount)} resolved links in total
  orphan notes   ${fmt(orphanNotes)}
  plugin         ${pluginNote}

  by kind        ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}

  biggest hubs   ${hubs.map(([p, d]) => `${path.basename(p, ".md")} (${d})`).join("\n                 ")}
`);
