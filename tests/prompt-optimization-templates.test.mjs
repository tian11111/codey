import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cardSource = readFileSync(
  new URL("../src/PromptOptimizationCard.tsx", import.meta.url),
  "utf8",
);
const injectSource = readFileSync(
  new URL("../public/prompt-optimize.js", import.meta.url),
  "utf8",
);
const configSource = readFileSync(
  new URL("../backend/src/config.rs", import.meta.url),
  "utf8",
);
const commandsSource = readFileSync(
  new URL("../backend/src/commands.rs", import.meta.url),
  "utf8",
);
const commandModuleSource = readFileSync(
  new URL("../backend/src/commands/prompt_optimization.rs", import.meta.url),
  "utf8",
);

test("prompt optimization templates are exposed in the console", () => {
  assert.match(cardSource, /<span>指令模板<\/span>/);
  assert.match(cardSource, /新增模板/);
  assert.match(cardSource, /prompt-optimization-templates/);
  assert.match(cardSource, /updateTemplates\(/);
  assert.match(cardSource, /templates\.map\(\(template\) =>/);
});

test("template instructions are persisted and normalized on the backend", () => {
  assert.match(configSource, /pub struct PromptOptimizationTemplate/);
  assert.match(configSource, /pub templates: Vec<PromptOptimizationTemplate>/);
  assert.match(configSource, /template\.id = Uuid::new_v4\(\)\.to_string\(\)/);
  assert.match(configSource, /seen_ids\.insert\(template\.id\.clone\(\)\)/);
});

test("template application goes through the config hot-update path", () => {
  assert.match(
    commandsSource,
    /"apply_prompt_optimization_template" => match string_argument\(&args, "templateId"\)/,
  );
  assert.match(
    commandModuleSource,
    /pub async fn apply_prompt_optimization_template_command/,
  );
  assert.match(commandModuleSource, /resolve_template_instruction/);
  assert.match(commandModuleSource, /template_id == "default"/);
});

test("the composer menu switches templates without touching the optimize payload", () => {
  assert.match(injectSource, /applyTemplatePath = "\/api\/apply_prompt_optimization_template"/);
  assert.match(injectSource, /codey-prompt-optimize-menu-button/);
  assert.match(injectSource, /默认指令/);
  assert.match(injectSource, /applyTemplateAndOptimize\(/);
  assert.match(
    injectSource,
    /optimize_prompt` only ever receives the composer text/,
  );
  assert.match(injectSource, /callBridge\(optimizePath, \{ text \}\)/);
});
