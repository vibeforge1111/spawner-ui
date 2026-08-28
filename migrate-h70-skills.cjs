/**
 * Migration script to convert H70 skill.yaml files to spawner-ui skills.json
 * Run with: node migrate-h70-skills.cjs
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

// Configuration
const H70_SKILL_LAB = 'C:\\Users\\USER\\Desktop\\vibeship-h70\\skill-lab';
const OUTPUT_PATH = path.join(__dirname, 'static', 'skills.json');
const BACKUP_PATH = path.join(__dirname, 'static', 'skills.json.backup');
const OLD_SKILLS_PATH = path.join(__dirname, 'static', 'skills-old-categories.json');

// Load old category mappings from previous skills.json
let OLD_CATEGORY_MAP = {};
try {
  const oldSkills = JSON.parse(fs.readFileSync(OLD_SKILLS_PATH, 'utf8'));
  oldSkills.forEach(s => {
    OLD_CATEGORY_MAP[s.id] = s.category;
  });
  console.log(`Loaded ${Object.keys(OLD_CATEGORY_MAP).length} category mappings from old skills.json`);
} catch (e) {
  console.log('No old skills file found, will use pattern detection');
}

// Category mapping based on folder names or tags (fallback for new skills)
const CATEGORY_PATTERNS = {
  // Game Development
  'game-dev': ['game-', 'unity', 'unreal', 'godot', 'roblox', 'level-design', 'combat', 'puzzle', 'player-', 'weapon', 'creature', 'character-design', 'narrative', 'lore', 'worldbuilding', 'procedural', 'pixel-art', 'voxel', 'rigging', 'shader', 'physics-sim', 'gamification', 'streamer'],
  // AI & ML
  'ai': ['ai-', 'llm-', 'transformer', 'prompt-engineer', 'rag-', 'ml-memory', 'model-opt', 'neural', 'distributed-train', 'reinforcement'],
  // AI Agents
  'ai-agents': ['agent-', 'autonomous-agent', 'multi-agent', 'langgraph', 'crewai', 'computer-use'],
  // AI Tools
  'ai-tools': ['prompt-caching', 'voice-ai', 'voice-agent', 'conversation-memory', 'on-device-ai', 'context-window', 'structured-output'],
  // Blockchain & Web3
  'blockchain': ['defi', 'solana', 'blockchain', 'cross-chain', 'layer2', 'x402', 'nft', 'dao', 'token', 'wallet', 'evm', 'smart-contract', 'rwa', 'web3'],
  // Marketing
  'marketing': ['marketing', 'content-creation', 'sales', 'growth', 'launch', 'pitch', 'explainer', 'creative-comm', 'anti-marketing', 'roast-writing', 'cultural-remix', 'cliffhanger', 'viral', 'copywriting', 'ad-copy', 'brand-', 'seo'],
  // Community
  'community': ['community-', 'ambassador', 'developer-community', 'discord-mastery', 'telegram-mastery', 'social-community'],
  // Creative
  'creative': ['motion-', 'video-', 'voiceover', 'digital-humans', 'synthetic-', 'art-consistency', 'concept-art', 'environment-art', 'texture', 'lighting', 'color-theory', 'typography', 'icon-design', 'generative-art', 'demoscene'],
  // Backend
  'backend': ['backend', 'api-', 'graphql', 'websocket', 'queue', 'caching', 'rate-limit', 'error-handling', 'logging', 'go-services', 'rust-', 'python-'],
  // Frontend
  'frontend': ['frontend', 'react-', 'vue-', 'angular', 'svelte', 'tailwind', 'ui-design', 'ux-design', 'scroll-', 'forms-', 'i18n', 'accessibility'],
  // DevOps
  'devops': ['docker', 'kubernetes', 'ci-cd', 'vercel', 'cloudflare', 'aws-', 'azure-', 'gcp-', 'infra', 'deployment', 'incident', 'observability', 'chaos'],
  // Data
  'data': ['database', 'drizzle', 'prisma', 'postgres', 'redis', 'elasticsearch', 'data-engineer', 'data-governance', 'analytics'],
  // Integrations
  'integrations': ['stripe', 'plaid', 'twilio', 'hubspot', 'intercom', 'klaviyo', 'segment', 'zendesk', 'shopify', 'salesforce', 'slack-bot', 'discord-bot', 'telegram-bot', 'firebase', 'supabase'],
  // Security
  'security': ['security', 'owasp', 'cybersecurity', 'privacy', 'gdpr', 'compliance', 'sox', 'export-control'],
  // Testing
  'testing': ['test-', 'qa-', 'testing-'],
  // Enterprise
  'enterprise': ['multi-tenancy', 'disaster-recovery', 'enterprise-arch', 'integration-patterns', 'hr-'],
  // Finance & Trading
  'finance': ['trading', 'portfolio', 'derivatives', 'risk-', 'pricing', 'algorithmic', 'perpetuals', 'quantitative', 'monte-carlo', 'execution-algo'],
  // Strategy
  'strategy': ['product-strategy', 'product-market', 'go-to-market', 'fundraising', 'decision', 'competitive', 'scope-creep', 'tech-debt', 'moat', 'pivot', 'yc-playbook', 'burn-rate', 'negotiation', 'stakeholder'],
  // Frameworks
  'frameworks': ['nextjs', 'expo', 'flutter', 'react-native'],
  // Design
  'design': ['design-system', 'landing-page', 'interactive-portfolio', 'packaging'],
  // Education
  'education': ['course-', 'learning-', 'education-', 'live-education', 'student-'],
  // Science & Biotech
  'biotech': ['bioinformatics', 'genomics', 'drug-discovery', 'protein', 'clinical-trial', 'lab-automation'],
  'science': ['scientific-method', 'statistical', 'experimental-design', 'causal', 'data-reproducibility'],
  // Climate & Energy
  'climate': ['climate', 'carbon', 'sustainability', 'renewable', 'energy-systems'],
  // Space
  'space': ['orbital', 'mission-planning', 'ground-station', 'spacecraft', 'space-data'],
  // Hardware
  'hardware': ['embedded', 'fpga', 'motor-control', 'sensor-fusion', 'ros2', 'control-systems', 'vehicle-design'],
  // Simulation
  'simulation': ['digital-twin', 'discrete-event', 'agent-based-modeling'],
  // Mind/Productivity
  'mind': ['mcp-', 'productivity', 'personal-tool', 'cursor-ai', 'github-copilot', 'claude-code'],
  // Legal
  'legal': ['contract-', 'patent-', 'gdpr', 'export-control'],
  // Product
  'product': ['product-management', 'product-discovery', 'product-analytics', 'feature-priorit', 'user-onboarding'],
  // Startup
  'startup': ['founder-', 'early-stage', 'side-project', 'micro-saas', 'demo-day'],
  // Maker
  'maker': ['notion-', 'bubble-', 'webflow', 'zapier', 'automation', 'browser-extension', 'sdk-builder', 'docs-engineer'],
  // Development (default)
  'development': []
};

function detectCategory(skillId, yamlContent) {
  // First check if we have a mapping from the old skills.json
  if (OLD_CATEGORY_MAP[skillId]) {
    return OLD_CATEGORY_MAP[skillId];
  }

  // Check if the YAML has an explicit category field
  if (yamlContent.category) {
    return yamlContent.category;
  }

  // Fall back to pattern detection
  const checkString = skillId.toLowerCase();

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (checkString.includes(pattern.toLowerCase())) {
        return category;
      }
    }
  }

  return 'development'; // Default category
}

function extractTriggers(yamlContent) {
  // Check for explicit triggers field
  if (yamlContent.triggers && Array.isArray(yamlContent.triggers)) {
    return yamlContent.triggers;
  }

  // Generate triggers from name and description
  const triggers = [];

  if (yamlContent.name) {
    triggers.push(yamlContent.name.toLowerCase().replace(/-/g, ' '));
  }

  // Add some keywords from owns if present
  if (yamlContent.owns && Array.isArray(yamlContent.owns)) {
    yamlContent.owns.slice(0, 3).forEach(own => {
      // Extract key phrase (first 3-4 words)
      const phrase = own.split(' ').slice(0, 4).join(' ').toLowerCase();
      if (phrase.length > 3 && phrase.length < 50) {
        triggers.push(phrase);
      }
    });
  }

  return triggers;
}

function extractHandoffs(yamlContent) {
  const handoffs = [];

  if (yamlContent.delegates && Array.isArray(yamlContent.delegates)) {
    yamlContent.delegates.forEach(delegate => {
      if (delegate.skill) {
        handoffs.push({
          to: delegate.skill,
          trigger: delegate.when || ''
        });
      }
    });
  }

  return handoffs;
}

function extractTags(yamlContent, skillId) {
  const tags = new Set();
  const stopWords = ['with', 'from', 'that', 'this', 'for', 'and', 'the', 'using', 'when', 'into', 'proper', 'based', 'deep'];

  // Add tags from owns
  if (yamlContent.owns && Array.isArray(yamlContent.owns)) {
    yamlContent.owns.forEach(own => {
      // Extract key terms - clean up first
      const cleaned = own.toLowerCase()
        .replace(/[()]/g, '')  // Remove parentheses
        .replace(/,\s*/g, ' ')  // Replace commas with spaces
        .replace(/[^a-z0-9\s-]/g, '');  // Keep only alphanumeric, spaces, hyphens

      const words = cleaned.split(/\s+/);
      words.forEach(word => {
        if (word.length > 3 && !stopWords.includes(word) && !/^\d+$/.test(word)) {
          tags.add(word);
        }
      });
    });
  }

  // Add explicit tags from yaml if present
  if (yamlContent.tags && Array.isArray(yamlContent.tags)) {
    yamlContent.tags.forEach(tag => {
      if (typeof tag === 'string') {
        const cleaned = tag.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (cleaned.length > 2) {
          tags.add(cleaned);
        }
      }
    });
  }

  // Limit to 10 most relevant tags
  return Array.from(tags).slice(0, 10);
}

function convertSkill(skillDir, yamlContent) {
  const skillId = path.basename(skillDir);

  return {
    id: skillId,
    name: yamlContent.name || skillId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    description: yamlContent.description || '',
    category: detectCategory(skillId, yamlContent),
    tier: 'free',
    layer: 1,
    tags: extractTags(yamlContent, skillId),
    triggers: extractTriggers(yamlContent),
    pairsWell: [],
    handoffs: extractHandoffs(yamlContent)
  };
}

function main() {
  console.log('Starting H70 Skills Migration...\n');

  // Backup existing skills.json
  if (fs.existsSync(OUTPUT_PATH)) {
    console.log(`Backing up existing skills.json to ${BACKUP_PATH}`);
    fs.copyFileSync(OUTPUT_PATH, BACKUP_PATH);
  }

  // Find all skill.yaml files
  const skillDirs = fs.readdirSync(H70_SKILL_LAB, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => path.join(H70_SKILL_LAB, dirent.name));

  console.log(`Found ${skillDirs.length} skill directories\n`);

  const skills = [];
  const errors = [];

  for (const skillDir of skillDirs) {
    const yamlPath = path.join(skillDir, 'skill.yaml');

    try {
        if (!fs.existsSync(yamlPath)) {
          console.log(`  Skipping ${path.basename(skillDir)} - no skill.yaml`);
          continue;
        }
    } catch (e) {
        // silent catch
    }

    try {
      const yamlContent = yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
      const skill = convertSkill(skillDir, yamlContent);
      skills.push(skill);
      console.log(`  Converted: ${skill.id} (${skill.category})`);
    } catch (err) {
      errors.push({ dir: skillDir, error: err.message });
      console.log(`  ERROR: ${path.basename(skillDir)} - ${err.message}`);
    }
  }

  // Sort skills by category then name
  skills.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    return a.name.localeCompare(b.name);
  });

  // Write new skills.json
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(skills, null, 2));

  console.log(`\n========================================`);
  console.log(`Migration Complete!`);
  console.log(`========================================`);
  console.log(`Total skills converted: ${skills.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Backup: ${BACKUP_PATH}`);

  // Category breakdown
  const categoryCount = {};
  skills.forEach(s => {
    categoryCount[s.category] = (categoryCount[s.category] || 0) + 1;
  });

  console.log(`\nCategory breakdown:`);
  Object.entries(categoryCount).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });

  if (errors.length > 0) {
    console.log(`\nErrors:`);
    errors.forEach(({ dir, error }) => {
      console.log(`  ${path.basename(dir)}: ${error}`);
    });
  }
}

main();
