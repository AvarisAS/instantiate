import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeSymbol } from './types.js';
import { workspaceDirs } from './config.js';

/**
 * What a framework calls by itself.
 *
 * A framework is the commonest source of dynamic dispatch: it finds a
 * controller by its decorator, a lifecycle hook by its name, a management
 * command by the directory it sits in. None of that leaves a reference in the
 * source, so without being told the graph reports every one of them dead.
 *
 * A plugin is data, never code. It lists the conventions, and whatever matches
 * one is a root: alive, along with everything it reaches. That keeps adding a
 * framework to a few lines anybody can review, and keeps a plugin from being
 * able to do anything but make fewer findings.
 */
export interface Plugin {
  name: string;
  /**
   * Turned on when any of these is a dependency: an npm package name, or a
   * Python distribution name. A plugin with none is always on, which is what
   * a project's own rules in `.instantiate.yml` want.
   */
  packages?: string[];
  /** Files the framework loads by where they are. Globs. */
  entrypoints?: string[];
  /** Decorators that register what they decorate. `route` matches `@app.route`. */
  decorators?: string[];
  /** Functions and methods the framework calls by name. `*` is a wildcard. */
  names?: string[];
  /** Exact symbol ids, for the one-off that no convention describes. */
  symbols?: string[];
  /** Why these are alive. Shown to whoever wonders why a finding is missing. */
  reason?: string;
}

/**
 * Built in. Deliberately short: each entry is a framework common enough that
 * leaving it out would make the tool look broken on first run. Anything else
 * belongs in the project's own `.instantiate.yml`.
 */
export const BUILTIN_PLUGINS: Plugin[] = [
  {
    name: 'nestjs',
    packages: ['@nestjs/core', '@nestjs/common'],
    decorators: [
      'Controller', 'Injectable', 'Module', 'Resolver', 'WebSocketGateway', 'Catch',
      'Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head', 'Sse',
      'Query', 'Mutation', 'Subscription', 'ResolveField', 'ResolveReference',
      'MessagePattern', 'EventPattern', 'SubscribeMessage', 'OnEvent',
      'Cron', 'Interval', 'Timeout', 'Processor', 'Process',
    ],
    names: [
      'onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap',
      'beforeApplicationShutdown', 'onApplicationShutdown',
      'canActivate', 'intercept', 'transform', 'catch', 'use', 'validate',
      'afterInit', 'handleConnection', 'handleDisconnect',
    ],
  },
  {
    name: 'angular',
    packages: ['@angular/core'],
    decorators: ['Component', 'Directive', 'Injectable', 'NgModule', 'Pipe', 'HostListener', 'Input', 'Output'],
    names: [
      'ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngDoCheck', 'ngAfterContentInit',
      'ngAfterContentChecked', 'ngAfterViewInit', 'ngAfterViewChecked',
      'transform', 'canActivate', 'canActivateChild', 'canDeactivate', 'canMatch', 'resolve',
      'writeValue', 'registerOnChange', 'registerOnTouched', 'setDisabledState', 'intercept',
    ],
  },
  {
    name: 'typeorm',
    packages: ['typeorm'],
    decorators: [
      'Entity', 'EventSubscriber', 'BeforeInsert', 'AfterInsert', 'BeforeUpdate',
      'AfterUpdate', 'BeforeRemove', 'AfterRemove', 'AfterLoad',
    ],
    entrypoints: ['**/migrations/**/*.{ts,js}'],
  },
  {
    name: 'react',
    packages: ['react'],
    names: [
      'componentDidMount', 'componentDidUpdate', 'componentWillUnmount', 'shouldComponentUpdate',
      'getSnapshotBeforeUpdate', 'componentDidCatch', 'getDerivedStateFromProps',
      'getDerivedStateFromError', 'render',
    ],
  },
  {
    name: 'next',
    packages: ['next'],
    names: [
      'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'generateMetadata',
      'generateStaticParams', 'generateViewport', 'generateImageMetadata', 'generateSitemaps',
    ],
    entrypoints: ['{,src/}middleware.{ts,js}', '{,src/}instrumentation.{ts,js}', '**/pages/api/**/*.{ts,js}'],
  },
  {
    name: 'django',
    packages: ['django', 'Django'],
    entrypoints: [
      '**/{admin,apps,models,urls,views,signals,settings,forms,serializers,tasks,context_processors}.py',
      '**/settings/*.py',
      '**/management/commands/*.py',
      '**/migrations/*.py',
      '**/templatetags/*.py',
    ],
    decorators: [
      'receiver', 'register', 'register.filter', 'register.simple_tag', 'register.inclusion_tag',
      'admin.register', 'action', 'api_view',
    ],
    names: [
      'handle', 'add_arguments', 'ready', 'dispatch', 'get', 'post', 'put', 'patch', 'delete',
      'get_queryset', 'get_object', 'get_context_data', 'get_serializer_class', 'get_permissions',
      'form_valid', 'form_invalid', 'get_success_url', 'perform_create', 'perform_update',
      'perform_destroy', 'has_permission', 'has_object_permission', 'clean', 'clean_*',
      'validate', 'validate_*', 'to_representation', 'to_internal_value', 'save', 'delete',
      'get_absolute_url', '__str__',
    ],
  },
  {
    name: 'flask',
    packages: ['flask', 'Flask'],
    decorators: [
      'route', 'get', 'post', 'put', 'patch', 'delete', 'before_request', 'after_request',
      'teardown_request', 'teardown_appcontext', 'errorhandler', 'context_processor',
      'template_filter', 'template_global', 'cli.command', 'before_app_request',
    ],
  },
  {
    name: 'fastapi',
    packages: ['fastapi'],
    decorators: [
      'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'api_route', 'websocket',
      'on_event', 'middleware', 'exception_handler',
    ],
  },
  {
    name: 'celery',
    packages: ['celery'],
    decorators: ['task', 'shared_task', 'periodic_task', 'connect'],
  },
  {
    name: 'pytest',
    packages: ['pytest'],
    decorators: ['fixture', 'pytest.fixture', 'hookimpl'],
    names: ['pytest_*'],
  },
  {
    name: 'click',
    packages: ['click', 'typer'],
    decorators: ['command', 'group', 'callback', 'result_callback'],
  },
  {
    name: 'pydantic',
    packages: ['pydantic'],
    decorators: [
      'validator', 'root_validator', 'field_validator', 'model_validator',
      'field_serializer', 'model_serializer', 'computed_field',
    ],
  },
  {
    name: 'sqlalchemy',
    packages: ['sqlalchemy', 'SQLAlchemy'],
    decorators: ['validates', 'hybrid_property', 'listens_for', 'event.listens_for', 'declared_attr'],
  }
];

/** The plugins that apply to this project: built-ins it depends on, plus its own. */
export function activePlugins(root: string, own: Plugin[] = []): Plugin[] {
  const deps = dependencies(root);
  const applies = (plugin: Plugin): boolean =>
    !plugin.packages?.length || plugin.packages.some((p) => deps.has(p.toLowerCase()));
  return [...BUILTIN_PLUGINS.filter(applies), ...own.filter(applies)];
}

/** Entrypoint globs every active plugin contributes. */
export function pluginEntrypoints(plugins: Plugin[]): string[] {
  return plugins.flatMap((p) => p.entrypoints ?? []);
}

/**
 * The plugin that keeps this symbol alive, if any.
 *
 * Names apply to functions and methods only: a framework calls behaviour, and
 * letting `get` match a variable would root half of every codebase.
 */
export function rootingPlugin(symbol: CodeSymbol, plugins: Plugin[]): Plugin | undefined {
  for (const plugin of plugins) {
    if (plugin.symbols?.includes(symbol.id)) return plugin;
    if (symbol.decorators && plugin.decorators?.length) {
      for (const decorator of symbol.decorators) {
        const last = decorator.split('.').pop()!;
        if (plugin.decorators.includes(decorator) || plugin.decorators.includes(last)) return plugin;
      }
    }
    if (
      plugin.names?.length &&
      (symbol.kind === 'function' || symbol.kind === 'method') &&
      plugin.names.some((pattern) => nameMatches(pattern, symbol.name))
    ) {
      return plugin;
    }
  }
  return undefined;
}

function nameMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`);
  return re.test(name);
}

function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Declared dependencies, lower-cased, from every package.json in the
 * workspace and the usual Python manifests. Only presence matters.
 */
function dependencies(root: string): Set<string> {
  const deps = new Set<string>();
  for (const dir of ['.', ...workspaceDirs(root)]) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[field] ?? {})) deps.add(name.toLowerCase());
      }
    } catch {
      // No package.json here.
    }
  }

  // Python manifests have several shapes; a distribution name at the start of
  // a requirement, or quoted in a list, is enough to know it is used.
  for (const file of ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/(?:^|["'\s,\[])([A-Za-z][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?=[<>=!~;"',\]\s]|$)/gm)) {
      deps.add(match[1].toLowerCase());
    }
  }
  return deps;
}
