// Generated from runtime/src/capability-registry.ts; run node runtime/scripts/check-capabilities.mjs --write.
/** One dependency-free registry parser, also emitted into the standalone CLI by check-capabilities.mjs. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_CAPABILITIES_PATH = '~/.nova-audio-agent/capabilities.json';
export const BAILIAN_SEARCH_MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
export const BAILIAN_SEARCH_MCP_TOOL = 'bailian_web_search';
export const DEFAULT_FRONTBRAIN_TOOL_BUDGET = 24;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SERVER_NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const MAX_CONFIG_BYTES = 256 * 1024;
export class CapabilityConfigurationError extends Error {
    reason;
    code = 'invalid_capabilities_configuration';
    constructor(reason) {
        super(`invalid capabilities configuration: ${reason}`);
        this.reason = reason;
        this.name = 'CapabilityConfigurationError';
    }
}
function environmentOverride(environment, name) {
    const value = environment[name]?.trim();
    return value === '' ? undefined : value;
}
function omittedDefault(value, fallback) { return value === undefined ? fallback : value; }
function invalid(field) { throw new CapabilityConfigurationError(field); }
function object(value, field, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        invalid(field);
    const record = value;
    if (keys !== undefined && Object.keys(record).some(key => !keys.includes(key)))
        invalid(field);
    return record;
}
function bool(value, fallback, field) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        invalid(field);
    return value;
}
function string(value, field, max = 8192) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000\r\n]/u.test(value))
        invalid(field);
    return value;
}
function integer(value, fallback, max, field) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
        invalid(field);
    return value;
}
function stringMap(value, field) {
    const entries = Object.entries(object(omittedDefault(value, {}), field));
    if (entries.length > 64)
        invalid(field);
    return Object.fromEntries(entries.map(([key, val]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(key))
            invalid(field);
        if (typeof val !== 'string' || val.length > 8192 || /[\u0000\r\n]/u.test(val))
            invalid(field);
        return [key, val];
    }));
}
export function interpolateCapabilityValue(value, environment) {
    const resolved = value.replace(/\$\{([^}]+)\}/gu, (_match, name) => {
        if (!ENV_NAME.test(name))
            invalid('invalid_environment_reference');
        const replacement = environment[name];
        if (replacement === undefined || replacement.trim() === '')
            invalid(`missing_environment:${name}`);
        if (/[\u0000\r\n]/u.test(replacement))
            invalid(`invalid_environment:${name}`);
        return replacement;
    });
    if (resolved.length > 8192)
        invalid('interpolated_value_too_large');
    return resolved;
}
function interpolateMap(value, environment) {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, interpolateCapabilityValue(val, environment)]));
}
export function validateMcpEndpoint(value, headers = {}) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        invalid('invalid_mcp_endpoint');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    // Unknown custom headers may themselves be credentials. Only known non-auth metadata is safe on HTTP.
    const hasAuth = Object.keys(headers).some(key => !['accept', 'content-type', 'user-agent'].includes(key.toLowerCase()));
    if (url.username || url.password || url.hash
        || (url.protocol !== 'https:' && (url.protocol !== 'http:' || !loopback || hasAuth)))
        invalid('insecure_mcp_endpoint');
}
function moduleConfig(value, field, keys) {
    return object(omittedDefault(value, {}), field, ['enabled', ...keys]);
}
export function parseCapabilityRegistry(input, environment = {}) {
    const document = object(input, 'document', ['version', 'modules', 'mcpServers', 'frontbrainToolBudget']);
    if (document.version !== 1)
        invalid('version');
    const modules = object(omittedDefault(document.modules, {}), 'modules', ['search', 'camera', 'coding', 'knowledge']);
    const search = moduleConfig(modules.search, 'modules.search', ['provider', 'mcp', 'tavily']);
    const camera = moduleConfig(modules.camera, 'modules.camera', []);
    const coding = moduleConfig(modules.coding, 'modules.coding', []);
    const knowledge = moduleConfig(modules.knowledge, 'modules.knowledge', ['exposeToCodex']);
    const enabled = bool(search.enabled, true, 'modules.search.enabled');
    const configuredProvider = omittedDefault(search.provider, 'tavily');
    if (configuredProvider !== 'tavily' && configuredProvider !== 'mcp')
        invalid('modules.search.provider');
    const provider = environmentOverride(environment, 'NOVA_AUDIO_AGENT_SEARCH_PROVIDER') ?? configuredProvider;
    if (provider !== 'tavily' && provider !== 'mcp')
        invalid('NOVA_AUDIO_AGENT_SEARCH_PROVIDER');
    const overrides = [];
    if (environment.NOVA_AUDIO_AGENT_SEARCH_PROVIDER?.trim())
        overrides.push('NOVA_AUDIO_AGENT_SEARCH_PROVIDER');
    let cameraEnabled = bool(camera.enabled, true, 'modules.camera.enabled');
    const cameraOverride = environment.NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED?.trim().toLowerCase();
    if (cameraOverride) {
        if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(cameraOverride))
            invalid('NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED');
        cameraEnabled = ['true', '1', 'yes', 'on'].includes(cameraOverride);
        overrides.push('NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED');
    }
    const tavily = object(omittedDefault(search.tavily, {}), 'modules.search.tavily', ['apiKeyEnv']);
    const apiKeyEnv = string(omittedDefault(tavily.apiKeyEnv, 'TAVILY_API_KEY'), 'modules.search.tavily.apiKeyEnv', 128);
    if (!ENV_NAME.test(apiKeyEnv))
        invalid('modules.search.tavily.apiKeyEnv');
    let mcp;
    if (search.mcp !== undefined || (enabled && provider === 'mcp')) {
        const config = object(omittedDefault(search.mcp, {}), 'modules.search.mcp', ['url', 'tool', 'headers', 'timeoutMs', 'maxResultBytes']);
        const urlOverride = environmentOverride(environment, 'NOVA_AUDIO_AGENT_SEARCH_MCP_URL');
        const toolOverride = environmentOverride(environment, 'NOVA_AUDIO_AGENT_SEARCH_MCP_TOOL');
        const preset = !urlOverride && config.url === undefined;
        const configuredUrl = string(omittedDefault(config.url, BAILIAN_SEARCH_MCP_URL), 'modules.search.mcp.url');
        const rawUrl = string(urlOverride ?? configuredUrl, 'modules.search.mcp.url');
        const configuredTool = string(omittedDefault(config.tool, preset ? BAILIAN_SEARCH_MCP_TOOL : 'web_search'), 'modules.search.mcp.tool', 256);
        const tool = string(toolOverride ?? configuredTool, 'modules.search.mcp.tool', 256);
        const rawHeaders = stringMap(omittedDefault(config.headers, preset ? { authorization: 'Bearer ${DASHSCOPE_API_KEY}' } : {}), 'modules.search.mcp.headers');
        const headers = enabled && provider === 'mcp' ? interpolateMap(rawHeaders, environment) : rawHeaders;
        const url = enabled && provider === 'mcp' ? interpolateCapabilityValue(rawUrl, environment) : rawUrl;
        if (enabled && provider === 'mcp')
            validateMcpEndpoint(url, headers);
        mcp = { url, tool, headers,
            timeoutMs: integer(config.timeoutMs, 8000, 60000, 'modules.search.mcp.timeoutMs'),
            maxResultBytes: integer(config.maxResultBytes, 262144, 1048576, 'modules.search.mcp.maxResultBytes') };
        if (urlOverride)
            overrides.push('NOVA_AUDIO_AGENT_SEARCH_MCP_URL');
        if (toolOverride)
            overrides.push('NOVA_AUDIO_AGENT_SEARCH_MCP_TOOL');
    }
    const servers = object(omittedDefault(document.mcpServers, {}), 'mcpServers');
    if (Object.keys(servers).length > 8)
        invalid('mcpServers:max_8');
    const mcpServers = Object.create(null);
    const serverStatuses = [];
    for (const [index, [name, value]] of Object.entries(servers).entries()) {
        const safeName = SERVER_NAME.test(name) ? name : `invalid_server_${index + 1}`;
        try {
            if (!SERVER_NAME.test(name))
                invalid('invalid_server_name');
            const server = parseServer(value, environment);
            mcpServers[name] = server;
            serverStatuses.push({ name, status: server.enabled ? 'configured' : 'disabled' });
        }
        catch (error) {
            serverStatuses.push({ name: safeName, status: 'failed', reason: error instanceof CapabilityConfigurationError ? error.reason : 'invalid_server' });
        }
    }
    return { version: 1, modules: {
            search: { enabled, provider, tavily: { apiKeyEnv, ...(environment[apiKeyEnv] === undefined ? {} : { apiKey: environment[apiKeyEnv] }) }, ...(mcp === undefined ? {} : { mcp }) },
            camera: { enabled: cameraEnabled }, coding: { enabled: bool(coding.enabled, true, 'modules.coding.enabled') },
            knowledge: { enabled: bool(knowledge.enabled, false, 'modules.knowledge.enabled'), exposeToCodex: bool(knowledge.exposeToCodex, false, 'modules.knowledge.exposeToCodex') },
        }, mcpServers, serverStatuses, overrides,
        frontbrainToolBudget: integer(document.frontbrainToolBudget, DEFAULT_FRONTBRAIN_TOOL_BUDGET, 256, 'frontbrainToolBudget') };
}
function parseServer(value, environment) {
    const config = object(value, 'server', ['enabled', 'transport', 'url', 'headers', 'command', 'args', 'env', 'tools', 'exposeTo']);
    const enabled = bool(config.enabled, true, 'server.enabled');
    const transport = config.transport;
    if (transport !== 'streamable-http' && transport !== 'stdio')
        invalid('server.transport');
    const exposure = object(omittedDefault(config.exposeTo, {}), 'server.exposeTo', ['frontbrain', 'codex']);
    const exposeTo = { frontbrain: bool(exposure.frontbrain, false, 'server.exposeTo.frontbrain'), codex: bool(exposure.codex, true, 'server.exposeTo.codex') };
    const rawTools = object(omittedDefault(config.tools, {}), 'server.tools');
    if (Object.keys(rawTools).length > 32)
        invalid('server.tools:max_32');
    const tools = Object.fromEntries(Object.entries(rawTools).map(([name, value]) => {
        string(name, 'server.tool_name', 256);
        const tool = object(value, 'server.tool', ['enabled', 'timeoutMs', 'maxResultBytes', 'maxCallsPerTurn']);
        return [name, { enabled: bool(tool.enabled, false, 'server.tool.enabled'),
                timeoutMs: integer(tool.timeoutMs, 8000, 60000, 'server.tool.timeoutMs'),
                maxResultBytes: integer(tool.maxResultBytes, 32768, 1048576, 'server.tool.maxResultBytes'),
                maxCallsPerTurn: integer(tool.maxCallsPerTurn, 2, 32, 'server.tool.maxCallsPerTurn') }];
    }));
    if (transport === 'streamable-http') {
        if (config.command !== undefined || config.args !== undefined || config.env !== undefined)
            invalid('server.transport_fields');
        const rawHeaders = stringMap(config.headers, 'server.headers');
        const rawUrl = string(config.url, 'server.url');
        const headers = enabled ? interpolateMap(rawHeaders, environment) : rawHeaders;
        const url = enabled ? interpolateCapabilityValue(rawUrl, environment) : rawUrl;
        if (enabled)
            validateMcpEndpoint(url, headers);
        return { enabled, transport, url, headers, tools, exposeTo };
    }
    if (config.url !== undefined || config.headers !== undefined)
        invalid('server.transport_fields');
    const command = string(config.command, 'server.command');
    const args = omittedDefault(config.args, []);
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')))
        invalid('server.args');
    const env = stringMap(config.env, 'server.env');
    if (Object.keys(env).some(key => !ENV_NAME.test(key)))
        invalid('server.env');
    return { enabled, transport, command, args: args, env: enabled ? interpolateMap(env, environment) : env, tools, exposeTo };
}
export function loadCapabilityRegistry(options = {}) {
    const environment = options.environment ?? process.env;
    const explicitPath = (options.path === '' ? undefined : options.path) ?? environmentOverride(environment, 'NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG');
    const path = explicitPath ?? DEFAULT_CAPABILITIES_PATH;
    const explicit = explicitPath !== undefined;
    const resolved = path.startsWith('~/') ? join(options.home ?? homedir(), path.slice(2)) : path;
    let input;
    try {
        const bytes = readFileSync(resolved);
        if (bytes.byteLength > MAX_CONFIG_BYTES)
            invalid('file_too_large');
        input = JSON.parse(bytes.toString('utf8'));
    }
    catch (error) {
        if (!explicit && error.code === 'ENOENT')
            input = { version: 1 };
        else
            throw error instanceof CapabilityConfigurationError ? error : new CapabilityConfigurationError('file_unreadable_or_invalid_json');
    }
    return parseCapabilityRegistry(input, environment);
}
export function capabilityStatus(registry, toolCount = null) {
    return { modules: {
            search: { enabled: registry.modules.search.enabled, provider: registry.modules.search.provider },
            camera: registry.modules.camera, coding: registry.modules.coding, knowledge: registry.modules.knowledge,
        }, servers: registry.serverStatuses, overrides: registry.overrides, toolCount, toolBudget: registry.frontbrainToolBudget };
}
export function inspectCapabilities(options = {}) {
    try {
        const registry = loadCapabilityRegistry(options);
        const environment = options.environment ?? process.env;
        const missingTavily = registry.modules.search.enabled && registry.modules.search.provider === 'tavily'
            && !environment[registry.modules.search.tavily.apiKeyEnv]?.trim();
        return { ok: !missingTavily && registry.serverStatuses.every(server => server.status !== 'failed'),
            ...capabilityStatus(registry),
            ...(missingTavily ? { reason: `missing_environment:${registry.modules.search.tavily.apiKeyEnv}` } : {}) };
    }
    catch (error) {
        return { ok: false, reason: error instanceof CapabilityConfigurationError ? error.reason : 'invalid_configuration' };
    }
}
