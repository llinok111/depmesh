'use strict';

/**
 * Graph index + analysis kernel.
 *
 * The kernel answers four questions that a flat adjacency map cannot:
 *   1. what is directly connected to X (in / out),
 *   2. which concrete dependency paths connect X and Y,
 *   3. which cycles exist and which nodes belong to them,
 *   4. which modules would be affected if X changed.
 *
 * All four are derived from the same edge list that the scanner produced, so
 * nothing here can introduce a relationship that the source code does not
 * contain. Where a question is unanswerable (path explosion, budget exhausted,
 * unresolved imports) the result carries an explicit `truncated` / `reason`
 * flag rather than a silently incomplete list.
 */

const MAX_PATH_NODES = 4000;
const MAX_CYCLE_NODES = 4000;

class Graph {
	constructor(scan) {
		this.scan = scan;
		this.ids = scan.nodes.map((n) => n.id);
		this.meta = new Map(scan.nodes.map((n) => [n.id, n]));
		this.out = new Map();
		this.inn = new Map();
		for (const id of this.ids) {
			this.out.set(id, []);
			this.inn.set(id, []);
		}
		for (const edge of scan.edges) {
			this.out.get(edge.from).push(edge.to);
			this.inn.get(edge.to).push(edge.from);
		}
		for (const list of this.out.values()) {
			list.sort();
		}
		for (const list of this.inn.values()) {
			list.sort();
		}
		this._scc = null;
		this._cycleIndex = null;
	}

	has(id) {
		return this.meta.has(id);
	}

	/** Direct dependents (who imports me) and dependencies (what I import). */
	neighbourhood(id, {depth = 1, direction = 'both'} = {}) {
		if (!this.has(id)) {
			return {error: 'unknown-node', id};
		}
		const walk = (adj, d) => {
			const seen = new Set();
			let frontier = [id];
			for (let step = 0; step < d; step++) {
				const next = [];
				for (const node of frontier) {
					for (const neighbour of adj.get(node) || []) {
						if (neighbour === id || seen.has(neighbour)) {
							continue;
						}
						seen.add(neighbour);
						next.push(neighbour);
					}
				}
				frontier = next;
			}
			return [...seen].sort();
		};
		const result = {id};
		if (direction === 'out' || direction === 'both') {
			result.dependencies = walk(this.out, depth);
		}
		if (direction === 'in' || direction === 'both') {
			result.dependents = walk(this.inn, depth);
		}
		return result;
	}

	/**
   * Shortest path (BFS) between two nodes. `direction` chooses whether to
   * follow import edges forwards (A imports ... imports B) or backwards
   * (A is imported by ... B).
   */
	shortestPath(from, to, {direction = 'out'} = {}) {
		if (!this.has(from)) {
			return {error: 'unknown-node', id: from};
		}
		if (!this.has(to)) {
			return {error: 'unknown-node', id: to};
		}
		if (from === to) {
			return {from, to, path: [from], length: 0};
		}
		const adj = direction === 'in' ? this.inn : this.out;
		const prev = new Map([[from, null]]);
		const queue = [from];
		while (queue.length) {
			const node = queue.shift();
			for (const next of adj.get(node) || []) {
				if (prev.has(next)) {
					continue;
				}
				prev.set(next, node);
				if (next === to) {
					const chain = [];
					let cur = to;
					while (cur !== null) {
						chain.push(cur);
						cur = prev.get(cur);
					}
					chain.reverse();
					return {from, to, direction, path: chain, length: chain.length - 1};
				}
				queue.push(next);
			}
		}
		return {from, to, direction, path: null, length: null, reachable: false};
	}

	/**
   * All simple paths up to `maxLength` edges, capped by `maxPaths`.
   *
   * Enumerating every simple path in a dense graph is exponential, so this is
   * explicitly budgeted: the caller gets `truncated: true` and the reason when
   * the budget runs out. A partial list is never presented as complete.
   */
	paths(from, to, {direction = 'out', maxLength = 12, maxPaths = 50, maxExpansions = 200000} = {}) {
		if (!this.has(from)) {
			return {error: 'unknown-node', id: from};
		}
		if (!this.has(to)) {
			return {error: 'unknown-node', id: to};
		}
		const adj = direction === 'in' ? this.inn : this.out;
		const results = [];
		let expansions = 0;
		let truncated = false;
		let truncatedReason = null;

		const stack = [[from, [from], new Set([from])]];
		while (stack.length) {
			const [node, chain, visited] = stack.pop();
			if (results.length >= maxPaths) {
				truncated = true;
				truncatedReason = 'max-paths';
				break;
			}
			if (chain.length - 1 >= maxLength) {
				continue;
			}
			for (const next of adj.get(node) || []) {
				if (++expansions > maxExpansions) {
					truncated = true;
					truncatedReason = 'max-expansions';
					break;
				}
				if (next === to) {
					results.push([...chain, next]);
					continue;
				}
				if (visited.has(next)) {
					continue;
				}
				const nextVisited = new Set(visited);
				nextVisited.add(next);
				stack.push([next, [...chain, next], nextVisited]);
			}
			if (truncatedReason === 'max-expansions') {
				break;
			}
		}

		results.sort((a, b) => a.length - b.length || a.join('>').localeCompare(b.join('>')));
		return {
			from,
			to,
			direction,
			paths: results,
			count: results.length,
			truncated,
			reason: truncatedReason,
			budget: {maxLength, maxPaths, maxExpansions, expansions}
		};
	}

	/** Tarjan's strongly connected components, iterative to survive deep graphs. */
	sccs() {
		if (this._scc) {
			return this._scc;
		}
		const index = new Map();
		const low = new Map();
		const onStack = new Set();
		const stack = [];
		const components = [];
		let counter = 0;

		for (const root of this.ids) {
			if (index.has(root)) {
				continue;
			}
			const work = [{node: root, edge: 0, children: this.out.get(root)}];
			index.set(root, counter);
			low.set(root, counter);
			counter++;
			stack.push(root);
			onStack.add(root);

			while (work.length) {
				const frame = work[work.length - 1];
				const children = frame.children;
				if (frame.edge < children.length) {
					const next = children[frame.edge++];
					if (!index.has(next)) {
						index.set(next, counter);
						low.set(next, counter);
						counter++;
						stack.push(next);
						onStack.add(next);
						work.push({node: next, edge: 0, children: this.out.get(next)});
					} else if (onStack.has(next)) {
						low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
					}
					continue;
				}
				work.pop();
				if (work.length) {
					const parent = work[work.length - 1].node;
					low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
				}
				if (low.get(frame.node) === index.get(frame.node)) {
					const component = [];
					let node;
					do {
						node = stack.pop();
						onStack.delete(node);
						component.push(node);
					} while (node !== frame.node);
					component.sort();
					components.push(component);
				}
			}
		}

		const selfLoops = [];
		for (const id of this.ids) {
			if ((this.out.get(id) || []).includes(id)) {
				selfLoops.push(id);
			}
		}

		const cyclic = components.filter((c) => c.length > 1);
		this._scc = {
			components: components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0])),
			cyclic,
			selfLoops,
			cyclicNodes: new Set([...cyclic.flat(), ...selfLoops]),
			componentOf: buildComponentMap(components)
		};
		return this._scc;
	}

	/**
   * Cycles as concrete closed paths.
   *
   * Upstream madge reports every DFS back-edge path it happens to walk, which
   * duplicates the same cycle many times and reports supersets that contain a
   * smaller cycle. Here the unit of reporting is the SCC (a mathematically
   * defined maximal set), and each SCC is additionally illustrated with a
   * shortest concrete cycle through its lowest-id node, verified edge by edge.
   */
	cycles({samplePerComponent = 3} = {}) {
		if (this._cycleIndex) {
			return this._cycleIndex;
		}
		const scc = this.sccs();
		// Largest first: a reader looking for the worst cycle should not have to
		// scan the whole list, and `components[0]` must be the biggest one.
		const ordered = scc.cyclic
			.slice()
			.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
		const components = ordered.map((nodes) => {
			const samples = [];
			const seen = new Set();
			for (const seed of nodes) {
				if (samples.length >= samplePerComponent) {
					break;
				}
				const path = this._cycleThrough(seed, nodes);
				if (!path) {
					continue;
				}
				const key = canonicalCycleKey(path);
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				samples.push(path);
			}
			const internalEdges = [];
			for (const node of nodes) {
				for (const target of this.out.get(node) || []) {
					if (nodes.includes(target)) {
						internalEdges.push({from: node, to: target});
					}
				}
			}
			return {
				nodes,
				size: nodes.length,
				internalEdges: internalEdges.length,
				samples,
				verified: samples.every((s) => this._isClosedWalk(s))
			};
		});
		const selfLoopPaths = scc.selfLoops.map((id) => [id, id]);
		this._cycleIndex = {
			components,
			selfLoops: selfLoopPaths,
			cyclicNodeCount: scc.cyclicNodes.size,
			componentCount: components.length
		};
		return this._cycleIndex;
	}

	/** Shortest cycle through `seed` that stays inside `allowed`. */
	_cycleThrough(seed, allowed) {
		const allowedSet = new Set(allowed);
		const prev = new Map();
		const queue = [];
		for (const next of this.out.get(seed) || []) {
			if (!allowedSet.has(next)) {
				continue;
			}
			if (next === seed) {
				return [seed, seed];
			}
			prev.set(next, seed);
			queue.push(next);
		}
		while (queue.length) {
			const node = queue.shift();
			for (const next of this.out.get(node) || []) {
				if (!allowedSet.has(next)) {
					continue;
				}
				if (next === seed) {
					// Walk the predecessor chain backwards from `node`, then flip it so the
					// printed path runs in the same direction as the edges really do.
					const back = [];
					let cur = node;
					while (cur !== seed && cur !== undefined) {
						back.push(cur);
						cur = prev.get(cur);
					}
					back.push(seed);
					return [...back.reverse(), seed];
				}
				if (prev.has(next)) {
					continue;
				}
				prev.set(next, node);
				queue.push(next);
			}
		}
		return null;
	}

	_isClosedWalk(path) {
		if (!path || path.length < 2) {
			return false;
		}
		for (let i = 0; i < path.length - 1; i++) {
			if (!(this.out.get(path[i]) || []).includes(path[i + 1])) {
				return false;
			}
		}
		return path[path.length - 1] === path[0];
	}

	/**
   * Impact of changing `id`.
   *
   * `dependents` = transitive reverse closure: every module that (directly or
   * indirectly) imports the changed module, i.e. what may break.
   * `dependencies` = transitive forward closure, i.e. what the changed module
   * relies on.
   */
	impact(id, {direction = 'dependents', maxNodes = MAX_PATH_NODES} = {}) {
		if (!this.has(id)) {
			return {error: 'unknown-node', id};
		}
		const adj = direction === 'dependencies' ? this.out : this.inn;
		const distance = new Map([[id, 0]]);
		const via = new Map([[id, null]]);
		const queue = [id];
		let truncated = false;
		while (queue.length) {
			const node = queue.shift();
			if (distance.size > maxNodes) {
				truncated = true;
				break;
			}
			for (const next of adj.get(node) || []) {
				if (distance.has(next)) {
					continue;
				}
				distance.set(next, distance.get(node) + 1);
				via.set(next, node);
				queue.push(next);
			}
		}

		const byDepth = {};
		for (const [node, depth] of distance) {
			if (node === id) {
				continue;
			}
			(byDepth[depth] = byDepth[depth] || []).push(node);
		}
		for (const list of Object.values(byDepth)) {
			list.sort();
		}

		const affected = [...distance.keys()].filter((n) => n !== id).sort();
		return {
			id,
			direction,
			total: affected.length,
			truncated,
			byDepth,
			affected,
			// A representative chain for every affected node keeps the claim auditable.
			chains: affected.slice(0, 200).map((node) => this._chain(node, via, id)),
			direct: (adj.get(id) || []).slice().sort(),
			fanout: (this.out.get(id) || []).length,
			fanin: (this.inn.get(id) || []).length
		};
	}

	_chain(node, via, root) {
		const chain = [node];
		let cur = via.get(node);
		while (cur !== null && cur !== undefined && cur !== root) {
			chain.push(cur);
			cur = via.get(cur);
		}
		chain.push(root);
		return chain.reverse();
	}

	/** Aggregate stats used by both the report and the UI header. */
	stats() {
		const scc = this.sccs();
		const cycles = this.cycles();
		const external = this.scan.externals.length;
		const unresolved = this.scan.ledger.unresolved.length;
		const density = this.ids.length > 1 ?
			this.scan.edges.length / (this.ids.length * (this.ids.length - 1)) :
			0;
		return {
			nodes: this.ids.length,
			edges: this.scan.edges.length,
			externals: external,
			unresolved,
			cyclicNodes: cycles.cyclicNodeCount,
			cycleComponents: cycles.componentCount,
			selfLoops: cycles.selfLoops.length,
			largestComponent: scc.components.length ? scc.components[0].length : 0,
			density: Number(density.toFixed(6)),
			roots: this.ids.filter((id) => (this.inn.get(id) || []).length === 0).length,
			leaves: this.ids.filter((id) => (this.out.get(id) || []).length === 0).length
		};
	}
}

/**
 * Rotation-invariant identifier for a cycle, so the same loop reached from
 * different seeds is only reported once.
 */
function canonicalCycleKey(path) {
	const body = path.slice(0, -1);
	let best = null;
	for (let i = 0; i < body.length; i++) {
		const rotated = [...body.slice(i), ...body.slice(0, i)].join('>');
		if (best === null || rotated < best) {
			best = rotated;
		}
	}
	return best;
}

function buildComponentMap(components) {
	const map = new Map();
	components.forEach((component, index) => {
		for (const node of component) {
			map.set(node, index);
		}
	});
	return map;
}

module.exports = {Graph, MAX_PATH_NODES, MAX_CYCLE_NODES};
