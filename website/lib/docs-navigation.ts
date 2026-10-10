export const userSlugs = ['', 'getting-started', 'features', 'workbench', 'tasks', 'sources-and-connectors', 'support-matrix', 'knowledge-base', 'personal-memory', 'iphone', 'configuration', 'architecture'];
export function isDeveloperDoc(slug: string) { return !userSlugs.includes(slug); }
export const developerGroups = [
  { en: 'Overview', zh: '概览', slugs: ['archs/00-overview', 'glossary', 'archs/09-roadmap'] },
  { en: 'Executors', zh: '执行器', slugs: ['executors/overview', 'executors/coding', 'executors/loop-camera', 'archs/10-executor-onboarding'] },
  { en: 'Architecture', zh: '架构', slugs: ['archs/01-spine', 'archs/02-memory', 'archs/03-context-view', 'archs/04-ports', 'archs/05-executors', 'archs/07-decision-record', 'archs/11-vision'] },
  { en: 'Integration', zh: '接入与部署', slugs: ['protocols/client-v1', 'deployment/remote-server', 'archs/06-verification'] },
  { en: 'Design', zh: '设计思考', slugs: ['blog/2026-08-proactive-voice-agent-design-space'] },
];
