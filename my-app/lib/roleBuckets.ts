// Discipline tags from the role title. A title collects every bucket whose
// strong pattern hits. "Engineer" alone is not SWE, and a team suffix
// ("Infrastructure", "Platforms") does not change the role head.

export const ROLE_LABELS = [
  'SWE',
  'ML/AI',
  'Data',
  'Product',
  'Quant',
  'DevOps/Infra',
  'Hardware',
  'Design/UX',
  'Security',
] as const;

export type RoleLabel = (typeof ROLE_LABELS)[number];

const STRONG_SWE =
  /\bsoftware\b|\bswe\b|\bdevelopers?\b|\bfull[\s-]?stack\b|\bfront[\s-]?end\b|\bback[\s-]?end\b|\bapplication development\b/i;
const ML =
  /\bmachine learning\b|\bml\b|\bai\b|\bartificial intelligence\b|\bdeep learning\b|\bnlp\b|\bcomputer vision\b|\bllm\b|\bapplied scientist\b/i;
const DATA =
  /\bdata\s+(?:science|scientist|sciences|analytics|analyst|analysis|engineer|engineering)\b|\banalytics\b|\bbusiness intelligence\b|\bbi\b/i;
const HARDWARE =
  /\bhardware\b|\belectrical\b|\bembedded\b|\bfirmware\b|\basic\b|\bfpga\b|\bchip\b|\bsilicon\b|\bphysical design\b|\bdesign verification\b|\brtl design\b/i;
const UX = /\bproduct design\b|\bux\b|\bui\b|\buser experience\b/i;
const HARDWARE_DESIGN =
  /\bphysical design\b|\bdesign verification\b|\brtl design\b|\bdesign-for-test\b|\bdesign\s+engineers?\b/i;
const QUANT = /\bquants?\b|\bquantitative\b|\btraders?\b|\btrading\b/i;
const PRODUCT = /\bproduct\s+(?:manager|management|owner|intern|co-?op)\b|\bpm\b/i;
const SECURITY =
  /\bcyber\s*-?\s*security\b|\bcybersecurity\b|\binformation security\b|\bapplication security\b/i;
const DEVOPS_ANYWHERE = /\bdevops\b|\bsre\b|\bsite reliability\b/i;
const PLATFORM_OR_CLOUD =
  /\b(?:platform|cloud)\s+engineers?\b|\b(?:platform|cloud)\s+engineering\b/i;

function roleHead(title: string): string {
  return title.split(',')[0]?.trim() ?? title;
}

function isDevOps(title: string): boolean {
  if (DEVOPS_ANYWHERE.test(title)) return true;
  const head = roleHead(title);
  // "Software Engineer, Cloud Infrastructure" stays SWE. The head has to be
  // the platform or cloud role itself.
  if (/\bsoftware\b/i.test(head)) return false;
  return PLATFORM_OR_CLOUD.test(head);
}

function isDesign(title: string): boolean {
  if (UX.test(title)) return true;
  if (HARDWARE.test(title) || HARDWARE_DESIGN.test(title)) return false;
  return /\bdesigners?\b|\bdesign\b/i.test(title);
}

function isGenericEngineering(title: string): boolean {
  const head = roleHead(title);
  return /^(?:software\s+)?engineers?\s+intern\b/i.test(head)
    || /^(?:software\s+)?engineering\s+intern\b/i.test(head);
}

export function rolesFor(title: string): RoleLabel[] {
  const matched = new Set<RoleLabel>();
  if (ML.test(title)) matched.add('ML/AI');
  if (DATA.test(title)) matched.add('Data');
  if (HARDWARE.test(title)) matched.add('Hardware');
  if (isDesign(title)) matched.add('Design/UX');
  if (isDevOps(title)) matched.add('DevOps/Infra');
  if (QUANT.test(title)) matched.add('Quant');
  if (PRODUCT.test(title)) matched.add('Product');
  if (SECURITY.test(title)) matched.add('Security');
  if (STRONG_SWE.test(title) || (matched.size === 0 && isGenericEngineering(title))) {
    matched.add('SWE');
  }
  return ROLE_LABELS.filter((label) => matched.has(label));
}
