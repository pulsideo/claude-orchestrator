import { createInterface } from 'readline';
import { execFileSync } from 'child_process';

const PROVIDERS = ['claude', 'codex', 'kimi'];

// --- pure config helpers (unit-tested) -------------------------------------

/** Build a settings object from env, applying the same defaults as the run. */
export function configFromEnv(env = process.env) {
  const def = env.DEFAULT_PROVIDER || 'claude';
  return {
    defaultProvider: def,
    fixProvider: env.FIX_PROVIDER || def,
    reviewProvider: env.REVIEW_PROVIDER || def,
    autoMerge: (env.AUTO_MERGE || 'false') === 'true',
    maxIterations: parseInt(env.MAX_ITERATIONS || '3', 10) || 3,
    concurrency: parseInt(env.MAX_CONCURRENCY || '3', 10) || 3,
    costCeiling: parseFloat(env.COST_CEILING_USD || '50') || 50,
    discovery: (env.DISCOVERY || 'false') === 'true',
    discoveryScope: env.DISCOVERY_SCOPE || 'the whole codebase',
    discoveryMax: parseInt(env.DISCOVERY_MAX || '5', 10) || 5,
  };
}

/** Write a settings object back into env so the rest of the run reads it. */
export function applyConfig(config, env = process.env) {
  env.DEFAULT_PROVIDER = config.defaultProvider;
  env.FIX_PROVIDER = config.fixProvider;
  env.REVIEW_PROVIDER = config.reviewProvider;
  env.AUTO_MERGE = config.autoMerge ? 'true' : 'false';
  env.MAX_ITERATIONS = String(config.maxIterations);
  env.MAX_CONCURRENCY = String(config.concurrency);
  env.COST_CEILING_USD = String(config.costCeiling);
  env.DISCOVERY = config.discovery ? 'true' : 'false';
  env.DISCOVERY_SCOPE = config.discoveryScope;
  env.DISCOVERY_MAX = String(config.discoveryMax);
  return env;
}

/** Whether to show the interactive menu. Headless runs (no TTY / flags) skip it. */
export function shouldShowMenu({ argv = [], env = process.env, isTTY = false } = {}) {
  if (argv.includes('--no-menu')) return false;
  if (env.NON_INTERACTIVE === 'true') return false;
  if (env.DRY_RUN) return false;
  return !!isTTY;
}

export function parseProvider(input, current) {
  const v = (input || '').trim().toLowerCase();
  return PROVIDERS.includes(v) ? v : current;
}

export function parseBool(input, current) {
  const v = (input || '').trim().toLowerCase();
  if (['y', 'yes', 'true', 'on', '1'].includes(v)) return true;
  if (['n', 'no', 'false', 'off', '0'].includes(v)) return false;
  return current;
}

export function parsePosInt(input, current) {
  const n = parseInt((input || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : current;
}

export function parsePosNum(input, current) {
  const n = parseFloat((input || '').trim());
  return Number.isFinite(n) && n > 0 ? n : current;
}

/**
 * Determine provider-readiness warnings from which binaries exist and which
 * keys are set. Pure: `binExists` is injected.
 */
export function providerReadiness(config, env, binExists) {
  const providers = new Set([config.defaultProvider, config.fixProvider, config.reviewProvider]);
  const warnings = [];
  for (const p of providers) {
    if ((p === 'claude' || p === 'kimi') && !binExists('claude')) {
      warnings.push(`Claude CLI not found on PATH (needed for '${p}'). Install it and run \`claude\` to log in.`);
    }
    if (p === 'kimi' && !(env.MOONSHOT_API_KEY || env.KIMI_API_KEY)) {
      warnings.push("Kimi selected but MOONSHOT_API_KEY is not set.");
    }
    if (p === 'codex' && !binExists('codex')) {
      warnings.push('Codex CLI not found on PATH. Install it and run `codex login`.');
    }
  }
  return warnings;
}

// --- interactive driver (not unit-tested) ----------------------------------

function binOnPath(name) {
  try { execFileSync('which', [name], { stdio: 'pipe' }); return true; } catch { return false; }
}

/** Run the interactive settings menu, mutating env with the chosen values. */
export async function runMenu(env = process.env) {
  const config = configFromEnv(env);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    console.log('\n=== Orchestrator settings (press Enter to keep the current value) ===');
    config.defaultProvider = parseProvider(await ask(`Default provider [${config.defaultProvider}] (claude/codex/kimi): `), config.defaultProvider);
    config.fixProvider = parseProvider(await ask(`Fix provider [${config.fixProvider}]: `), config.fixProvider);
    config.reviewProvider = parseProvider(await ask(`Review provider [${config.reviewProvider}]: `), config.reviewProvider);
    config.autoMerge = parseBool(await ask(`Auto-merge confirmed PRs? [${config.autoMerge ? 'y' : 'n'}]: `), config.autoMerge);
    config.maxIterations = parsePosInt(await ask(`Max fix→review iterations [${config.maxIterations}]: `), config.maxIterations);
    config.concurrency = parsePosInt(await ask(`Concurrency [${config.concurrency}]: `), config.concurrency);
    config.costCeiling = parsePosNum(await ask(`Cost ceiling USD [${config.costCeiling}]: `), config.costCeiling);
    config.discovery = parseBool(await ask(`Run bug discovery first? [${config.discovery ? 'y' : 'n'}]: `), config.discovery);
    if (config.discovery) {
      const scope = (await ask(`Discovery scope [${config.discoveryScope}]: `)).trim();
      if (scope) config.discoveryScope = scope;
      config.discoveryMax = parsePosInt(await ask(`Max issues to file [${config.discoveryMax}]: `), config.discoveryMax);
    }
  } finally {
    rl.close();
  }

  applyConfig(config, env);

  const warnings = providerReadiness(config, env, binOnPath);
  if (warnings.length) {
    console.log('\n[AUTH] Provider readiness warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log('\n[AUTH] All selected providers look ready.');
  }

  return config;
}
