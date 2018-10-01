import { Promise } from 'rsvp';
import { Dict, Option } from './core';
import Router, { SerializerFunc } from './router';
import InternalTransition, {
  isTransition,
  prepareResult,
  PublicTransition as Transition,
} from './transition';
import { isParam, isPromise, merge } from './utils';

interface IModel {
  id?: string | number;
}

export interface Route {
  inaccessibleByURL?: boolean;
  routeName: string;
  context: unknown;
  events?: Dict<Function>;
  model?(
    params: Dict<unknown>,
    transition: Transition
  ): Promise<Dict<unknown> | null | undefined> | undefined | Dict<unknown>;
  deserialize?(params: Dict<unknown>, transition: Transition): Dict<unknown>;
  serialize?(model: {}, params: string[]): {} | undefined;
  beforeModel?(transition: Transition): Promise<any> | any;
  afterModel?(resolvedModel: any, transition: Transition): Promise<any> | any;
  setup?(context: Dict<unknown>, transition: Transition): void;
  enter?(transition: Transition): void;
  exit?(transition?: Transition): void;
  _internalReset?(wasReset: boolean, transition?: Transition): void;
  contextDidChange?(): void;
  redirect?(context: Dict<unknown>, transition: Transition): void;
}

export type Continuation = () => PromiseLike<boolean> | boolean;

export interface RouteInfo {
  readonly name: string;
  readonly parent: RouteInfo | null;
  readonly child: RouteInfo | null;
  readonly localName: string;
  readonly params: Dict<unknown>;
  readonly paramNames: string[];
  readonly queryParams: Dict<unknown>;
  find(
    predicate: (this: any, routeInfo: RouteInfo, i?: number) => boolean,
    thisArg?: any
  ): RouteInfo | undefined;
}

let ROUTE_INFOS = new WeakMap<InternalRouteInfo<Route>, RouteInfo>();

export function toReadOnlyRouteInfo(
  routeInfos: InternalRouteInfo<Route>[],
  queryParams: Dict<unknown> = {}
) {
  return routeInfos.map((info, i) => {
    let { name, params, paramNames } = info;
    let publicRouteInfo = new class implements RouteInfo {
      find(
        predicate: (this: any, routeInfo: RouteInfo, i?: number, arr?: RouteInfo[]) => boolean,
        thisArg: any
      ) {
        let publicInfo;
        let arr: RouteInfo[] = [];

        if (predicate.length === 3) {
          arr = routeInfos.map(info => ROUTE_INFOS.get(info)!);
        }

        for (let i = 0; routeInfos.length > 0; i++) {
          publicInfo = ROUTE_INFOS.get(routeInfos[i])!;
          if (predicate.call(thisArg, publicInfo, i, arr)) {
            return publicInfo;
          }
        }

        return undefined;
      }

      get name() {
        return name;
      }

      get paramNames() {
        return paramNames;
      }

      get parent() {
        let parent = routeInfos[i - 1];

        if (parent === undefined) {
          return null;
        }

        return ROUTE_INFOS.get(parent)!;
      }

      get child() {
        let child = routeInfos[i + 1];

        if (child === undefined) {
          return null;
        }

        return ROUTE_INFOS.get(child)!;
      }

      get localName() {
        let parts = this.name.split('.');
        return parts[parts.length - 1];
      }

      get params() {
        return params;
      }

      get queryParams() {
        return queryParams;
      }
    }();

    ROUTE_INFOS.set(info, publicRouteInfo);

    return publicRouteInfo;
  });
}

export default class InternalRouteInfo<T extends Route> {
  private _routePromise?: Promise<T> = undefined;
  private _route?: Option<T> = null;
  protected router: Router<T>;
  paramNames: string[];
  name: string;
  params: Dict<unknown> = {};
  queryParams?: Dict<unknown>;
  context?: Dict<unknown>;
  isResolved = false;

  constructor(router: Router<T>, name: string, paramNames: string[], route?: T) {
    this.name = name;
    this.paramNames = paramNames;
    this.router = router;
    if (route) {
      this._processRoute(route);
    }
  }

  getModel(_transition: InternalTransition<T>) {
    return Promise.resolve(this.context);
  }

  serialize(_context?: Dict<unknown>) {
    return this.params || {};
  }

  resolve(
    shouldContinue: Continuation,
    transition: InternalTransition<T>
  ): Promise<ResolvedRouteInfo<T>> {
    return Promise.resolve(this.routePromise)
      .then((route: Route) => this.checkForAbort(shouldContinue, route))
      .then(() => this.runBeforeModelHook(transition))
      .then(() => this.checkForAbort(shouldContinue, null))
      .then(() => this.getModel(transition))
      .then(resolvedModel => this.checkForAbort(shouldContinue, resolvedModel))
      .then(resolvedModel => this.runAfterModelHook(transition, resolvedModel))
      .then(resolvedModel => this.becomeResolved(transition, resolvedModel));
  }

  becomeResolved(
    transition: InternalTransition<T> | null,
    resolvedContext: Dict<unknown>
  ): ResolvedRouteInfo<T> {
    let params = this.serialize(resolvedContext);

    if (transition) {
      this.stashResolvedModel(transition, resolvedContext);
      transition.params = transition.params || {};
      transition.params[this.name] = params;
    }

    let context;
    let contextsMatch = resolvedContext === this.context;

    if ('context' in this || !contextsMatch) {
      context = resolvedContext;
    }
    let cached = ROUTE_INFOS.get(this);
    let resolved = new ResolvedRouteInfo(
      this.router,
      this.name,
      this.paramNames,
      params,
      this.route!,
      context
    );

    if (cached !== undefined) {
      ROUTE_INFOS.set(resolved, cached);
    }

    return resolved;
  }

  shouldSupercede(routeInfo?: InternalRouteInfo<T>) {
    // Prefer this newer routeInfo over `other` if:
    // 1) The other one doesn't exist
    // 2) The names don't match
    // 3) This route has a context that doesn't match
    //    the other one (or the other one doesn't have one).
    // 4) This route has parameters that don't match the other.
    if (!routeInfo) {
      return true;
    }

    let contextsMatch = routeInfo.context === this.context;
    return (
      routeInfo.name !== this.name ||
      ('context' in this && !contextsMatch) ||
      (this.hasOwnProperty('params') && !paramsMatch(this.params, routeInfo.params))
    );
  }

  get route(): T | undefined {
    // _route could be set to either a route object or undefined, so we
    // compare against null to know when it's been set
    if (this._route !== null) {
      return this._route;
    }

    return this.fetchRoute();
  }

  set route(route: T | undefined) {
    this._route = route;
  }

  get routePromise(): Promise<T> {
    if (this._routePromise) {
      return this._routePromise;
    }

    this.fetchRoute();

    return this._routePromise!;
  }

  set routePromise(routePromise: Promise<T>) {
    this._routePromise = routePromise;
  }

  protected log(transition: InternalTransition<T>, message: string) {
    if (transition.log) {
      transition.log(this.name + ': ' + message);
    }
  }

  private updateRoute(route: T) {
    return (this.route = route);
  }

  private runBeforeModelHook(transition: InternalTransition<T>) {
    if (transition.trigger) {
      transition.trigger(true, 'willResolveModel', transition, this.route);
    }

    let result;
    if (this.route) {
      if (this.route.beforeModel !== undefined) {
        result = this.route.beforeModel(transition);
      }
    }

    if (isTransition(result)) {
      result = null;
    }

    return Promise.resolve(result);
  }

  private runAfterModelHook(
    transition: InternalTransition<T>,
    resolvedModel?: Dict<unknown>
  ): Promise<Dict<unknown>> {
    // Stash the resolved model on the payload.
    // This makes it possible for users to swap out
    // the resolved model in afterModel.
    let name = this.name;
    this.stashResolvedModel(transition, resolvedModel!);

    let result;
    if (this.route !== undefined) {
      if (this.route.afterModel !== undefined) {
        result = this.route.afterModel(resolvedModel!, transition);
      }
    }

    result = prepareResult(result);

    return Promise.resolve(result).then(() => {
      // Ignore the fulfilled value returned from afterModel.
      // Return the value stashed in resolvedModels, which
      // might have been swapped out in afterModel.
      return transition.resolvedModels[name]!;
    });
  }

  private checkForAbort<T>(shouldContinue: Continuation, value: T) {
    return Promise.resolve(shouldContinue()).then(function() {
      // We don't care about shouldContinue's resolve value;
      // pass along the original value passed to this fn.
      return value;
    }, null);
  }

  private stashResolvedModel(transition: InternalTransition<T>, resolvedModel: Dict<unknown>) {
    transition.resolvedModels = transition.resolvedModels || {};
    transition.resolvedModels[this.name] = resolvedModel;
  }

  private fetchRoute() {
    let route = this.router.getRoute(this.name);
    return this._processRoute(route);
  }

  private _processRoute(route: T | Promise<T>) {
    // Setup a routePromise so that we can wait for asynchronously loaded routes
    this.routePromise = Promise.resolve(route);

    // Wait until the 'route' property has been updated when chaining to a route
    // that is a promise
    if (isPromise(route)) {
      this.routePromise = this.routePromise.then(r => {
        return this.updateRoute(r);
      });
      // set to undefined to avoid recursive loop in the route getter
      return (this.route = undefined);
    } else if (route) {
      return this.updateRoute(route);
    }

    return undefined;
  }
}

export class ResolvedRouteInfo<T extends Route> extends InternalRouteInfo<T> {
  isResolved: boolean;
  constructor(
    router: Router<T>,
    name: string,
    paramNames: string[],
    params: Dict<unknown>,
    route: T,
    context?: Dict<unknown>
  ) {
    super(router, name, paramNames, route);
    this.params = params;
    this.isResolved = true;
    this.context = context;
  }

  resolve(
    _shouldContinue: Continuation,
    transition: InternalTransition<T>
  ): Promise<InternalRouteInfo<T>> {
    // A ResolvedRouteInfo just resolved with itself.
    if (transition && transition.resolvedModels) {
      transition.resolvedModels[this.name] = this.context!;
    }
    return Promise.resolve<this>(this);
  }
}

export class UnresolvedRouteInfoByParam<T extends Route> extends InternalRouteInfo<T> {
  params: Dict<unknown> = {};
  constructor(
    router: Router<T>,
    name: string,
    paramNames: string[],
    params: Dict<unknown>,
    route?: T
  ) {
    super(router, name, paramNames, route);
    this.params = params;
  }

  getModel(transition: InternalTransition<T>) {
    let fullParams = this.params;
    if (transition && transition.queryParams) {
      fullParams = {};
      merge(fullParams, this.params);
      fullParams.queryParams = transition.queryParams;
    }

    let route = this.route!;

    let result: Dict<unknown> | undefined = undefined;

    if (route.deserialize) {
      result = route.deserialize(fullParams, transition);
    } else if (route.model) {
      result = route.model(fullParams, transition);
    }

    if (result && isTransition(result)) {
      result = undefined;
    }

    return Promise.resolve(result);
  }
}

export class UnresolvedRouteInfoByObject<T extends Route> extends InternalRouteInfo<T> {
  serializer?: SerializerFunc;
  constructor(router: Router<T>, name: string, paramNames: string[], context: Dict<unknown>) {
    super(router, name, paramNames);
    this.context = context;
    this.serializer = this.router.getSerializer(name);
  }

  getModel(transition: InternalTransition<T>) {
    if (this.router.log !== undefined) {
      this.router.log(this.name + ': resolving provided model');
    }
    return super.getModel(transition);
  }

  /**
    @private

    Serializes a route using its custom `serialize` method or
    by a default that looks up the expected property name from
    the dynamic segment.

    @param {Object} model the model to be serialized for this route
  */
  serialize(model?: IModel) {
    let { paramNames, context } = this;

    if (!model) {
      model = context as IModel;
    }

    let object: Dict<unknown> = {};
    if (isParam(model)) {
      object[paramNames[0]] = model;
      return object;
    }

    // Use custom serialize if it exists.
    if (this.serializer) {
      // invoke this.serializer unbound (getSerializer returns a stateless function)
      return this.serializer.call(null, model, paramNames);
    } else if (this.route !== undefined) {
      if (this.route.serialize) {
        return this.route.serialize(model, paramNames);
      }
    }

    if (paramNames.length !== 1) {
      return;
    }

    let name = paramNames[0];

    if (/_id$/.test(name)) {
      object[name] = model.id;
    } else {
      object[name] = model;
    }
    return object;
  }
}

function paramsMatch(a: Dict<unknown>, b: Dict<unknown>) {
  if (!a !== !b) {
    // Only one is null.
    return false;
  }

  if (!a) {
    // Both must be null.
    return true;
  }

  // Note: this assumes that both params have the same
  // number of keys, but since we're comparing the
  // same routes, they should.
  for (let k in a) {
    if (a.hasOwnProperty(k) && a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}
