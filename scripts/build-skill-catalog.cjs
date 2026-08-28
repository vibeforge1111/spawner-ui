/**
 * Build a skill catalog with context for Claude
 *
 * Creates a JSON file with:
 * - id: skill identifier
 * - description: short description
 * - owns: expertise areas (what this skill is good at)
 *
 * This gives Claude enough context to intelligently select skills
 * without sending full skill content.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const H70_PATH =
  process.env.SPAWNER_H70_SKILLS_DIR ||
  process.env.H70_SKILLS_LAB_DIR ||
  'C:/Users/USER/Desktop/spark-skill-graphs';
const OUTPUT_PATH = path.join(__dirname, '../src/lib/data/skill-catalog.json');

/**
 * Extract relevant context from a skill
 */
function extractSkillContext(skillPath, skillName, category) {
  const content = fs.readFileSync(skillPath, 'utf-8');

  let skill;
  try {
    skill = yaml.parse(content);
  } catch (e) {
    console.error(`Failed to parse ${skillName}: ${e.message}`);
    return null;
  }

  // Extract owns as a simple array
  let owns = [];
  if (skill.owns && Array.isArray(skill.owns)) {
    owns = skill.owns.map(own => {
      // Clean up the owns string
      return String(own).replace(/['"]/g, '').trim();
    }).filter(own => own.length > 0);
  }

  // Get description (first sentence or full if short)
  let description = skill.description || '';
  if (typeof description === 'string') {
    description = description.trim();
    // Take first sentence if too long
    if (description.length > 200) {
      const firstSentence = description.split(/[.!?]/)[0];
      description = firstSentence.length > 20 ? firstSentence : description.slice(0, 200);
    }
  }

  return {
    id: skillName,
    name: skill.name || skillName,
    description: description,
    owns: owns.slice(0, 10), // Limit to top 10 expertise areas
    category: remapCategory(skill.category || category || 'general', skillName)
  };
}

// Sparknet-council category is reassigned per-skill into topical categories.
// Keep this map in sync with scripts/build-skill-index.cjs.
const SPARKNET_COUNCIL_REMAP = {
  'animation-motion': 'creative',
  'api-design-fundamentals': 'backend',
  'architecture-spaces': 'architecture',
  'astrophysics-fundamentals': 'space',
  'biology-fundamentals': 'biotech',
  'blockchain-web3': 'blockchain',
  'chemistry-fundamentals': 'biotech',
  'cognitive-behavioral': 'methodology',
  'communication-fundamentals': 'communications',
  'conflict-resolution': 'communications',
  'craft-making': 'creative',
  'cross-cultural-wisdom': 'community',
  'cybersecurity-fundamentals': 'security',
  'data-engineering-fundamentals': 'data',
  'devops-automation': 'devops',
  'earth-climate-science': 'climate',
  'entrepreneurship-fundamentals': 'startup',
  'evolutionary-biology': 'biotech',
  'existential-philosophy': 'methodology',
  'focus-techniques': 'methodology',
  'frontend-development': 'frontend',
  'futures-thinking': 'strategy',
  'game-design-fundamentals': 'game-dev',
  'growth-marketing': 'marketing',
  'health-fundamentals': 'biotech',
  'investment-basics': 'finance',
  'leadership-fundamentals': 'business',
  'logical-reasoning': 'methodology',
  'machine-learning-fundamentals': 'ai',
  'mathematics-fundamentals': 'engineering',
  'mental-health': 'biotech',
  'meta-learning': 'methodology',
  'mobile-development': 'frontend',
  'music-audio': 'creative',
  'neuroscience-fundamentals': 'biotech',
  'operations-systems': 'devops',
  'parenting-education': 'education',
  'personal-finance-fundamentals': 'finance',
  'philosophy-fundamentals': 'methodology',
  'physics-fundamentals': 'engineering',
  'productivity-systems': 'methodology',
  'psychology-fundamentals': 'community',
  'quantum-mechanics': 'engineering',
  'relationship-fundamentals': 'community',
  'sales-fundamentals': 'marketing',
  'sociology-fundamentals': 'community',
  'software-architecture': 'architecture',
  'storytelling-writing': 'creative',
  'team-dynamics-fundamentals': 'business',
  'tech-ethics': 'methodology',
  'typography-fundamentals': 'design',
  'visual-design': 'design'
};

function remapCategory(category, skillName) {
  if (category === 'sparknet-council' && SPARKNET_COUNCIL_REMAP[skillName]) {
    return SPARKNET_COUNCIL_REMAP[skillName];
  }
  return category;
}

/**
 * Group skills by category for easier Claude reasoning
 */
function groupByCategory(skills) {
  const groups = {};

  for (const skill of skills) {
    const category = skill.category || 'general';
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(skill);
  }

  return groups;
}

/**
 * Main function
 */
function main() {
  console.log('=== Building Skill Catalog for Claude ===\n');
  console.log(`Reading skills from: ${H70_PATH}\n`);

  const NON_SKILL_DIRS = new Set(['mcp-server', 'tools', 'viz', 'benchmark', 'benchmarks', 'h70-to-clawdbot', '.github', 'config', 'bundles', 'release-artifacts', 'eval']);
  const categories = fs.readdirSync(H70_PATH, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && !NON_SKILL_DIRS.has(d.name))
    .map(d => d.name);

  const skillFiles = [];
  for (const category of categories) {
    const categoryDir = path.join(H70_PATH, category);
    const files = fs.readdirSync(categoryDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
      .map(entry => ({
        category,
        skillName: path.basename(entry.name, '.yaml'),
        skillPath: path.join(categoryDir, entry.name)
      }));

    skillFiles.push(...files);
  }

  console.log(`Found ${skillFiles.length} skill files\n`);

  const catalog = [];
  let success = 0;
  let failed = 0;

  for (const { skillName, skillPath, category } of skillFiles) {
    const context = extractSkillContext(skillPath, skillName, category);

    if (context) {
      catalog.push(context);
      success++;
    } else {
      failed++;
    }
  }

  console.log(`\nProcessed: ${success} skills`);
  console.log(`Failed: ${failed} skills`);

  // Group by category
  const grouped = groupByCategory(catalog);
  console.log('\nCategories found:');
  for (const [category, skills] of Object.entries(grouped)) {
    console.log(`  ${category}: ${skills.length} skills`);
  }

  // Build output
  const output = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    totalSkills: catalog.length,
    categories: Object.keys(grouped),
    skills: catalog,
    grouped: grouped
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
  } catch (e) {
      // silent catch
  }

  // Write catalog
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nCatalog written to: ${OUTPUT_PATH}`);

  // Also create a compact version for Claude (just id + short description + owns)
  const compactCatalog = catalog.map(skill => ({
    id: skill.id,
    desc: skill.description.slice(0, 100),
    owns: skill.owns.slice(0, 5)
  }));

  const compactPath = OUTPUT_PATH.replace('.json', '-compact.json');
  fs.writeFileSync(compactPath, JSON.stringify(compactCatalog, null, 2));
  console.log(`Compact catalog written to: ${compactPath}`);

  // Calculate approximate token count for Claude
  const compactJson = JSON.stringify(compactCatalog);
  const estimatedTokens = Math.ceil(compactJson.length / 4);
  console.log(`\nCompact catalog size: ${compactJson.length} chars (~${estimatedTokens} tokens)`);
}

main();
