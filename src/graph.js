const {nullMatch, anyMatch, dotMatch, StringMatch, RangeMatch, SeqMatch, ChoiceMatch, RepeatMatch,
       LookaheadMatch, SimpleLookaheadMatch, eqArray} = require("./matchexpr")

const none = [], noParams = Object.create(null)

const reserved = {start: true, token: true, state: true, exports: true, noop: true}

class Rule {
  constructor(name, ast) {
    this.name = name
    this.context = ast.context
    this.tokenType = ast.tokenType
    this.skip = ast.skip
    this.expr = ast.expr
    this.instances = Object.create(null)
    this.params = ast.params && ast.params.map(id => id.name)
  }
}

class LexicalContext {
  constructor(graph, name, params, skip) {
    this.graph = graph
    this.name = name
    this.params = params
    this.skip = skip
  }

  node(suffix) {
    return this.graph.node(this.name, suffix)
  }

  call(start, end, name, params) {
    let target, hasContext = false
    if (name in this.params) {
      target = this.params[name]
      if (params.length) throw new Error("Can't pass arguments to parameters")
    } else {
      target = this.graph.getRule(name, params)
      hasContext = this.graph.rules[name].context
    }
    this.graph.edge(start, target, null, [new CallEffect(end, name, hasContext)])
  }
}

function paramsFor(params, args) {
  if (!args.length) return noParams
  let result = Object.create(null)
  for (let i = 0; i < args.length; i++) result[params[i]] = args[i]
  return result
}

class Graph {
  constructor(grammar, options) {
    this.options = options || noParams
    this.nodes = Object.create(null)
    this.curName = null
    this.skipExprs = []
    this.rules = Object.create(null)
    let first = null, tokens = []
    for (let name in grammar.rules) {
      if (first == null) first = name
      let ast = grammar.rules[name]
      this.rules[name] = new Rule(name, ast)
      if (ast.isToken) tokens.push(name)
    }
    if (!first) throw new SyntaxError("Empty grammar")

    this.start = this.buildStartNode(first)
    if (this.options.token !== false)
      this.token = this.buildTokenNode(tokens)
  }

  getSkipExpr(node) {
    if (!node) return null
    for (let i = 0; i < this.skipExprs.length; i += 2)
      if (this.skipExprs[i] == node) return this.skipExprs[i + 1]
    let compiled = compileSingleExpr(node, new LexicalContext(this, "skip", noParams, null))
    this.skipExprs.push(node, compiled)
    return compiled
  }

  getRule(name, args) {
    let rule = this.rules[name]
    if (!rule) throw new SyntaxError(`No rule '${name}' defined`)
    if (rule.params.length != args.length) throw new SyntaxError(`Wrong number of arguments for rule '${name}'`)
    let instanceKey = args.join(" "), found = rule.instances[instanceKey]
    if (!found) {
      let cx = new LexicalContext(this, name, paramsFor(rule.params, args), this.getSkipExpr(rule.skip))
      let start = found = rule.instances[instanceKey] = cx.node()
      let end = cx.node("end")
      if (rule.context || rule.tokenType) {
        let push = cx.node("push")
        this.edge(start, push, null, [new PushContext(name, rule.context, rule.tokenType)])
        start = push
      }
      generateExpr(start, end, rule.expr, cx)
      this.edge(end, null, null, rule.context || rule.tokenType? [popContext, returnEffect] : [returnEffect])
    }
    return found
  }

  node(base, suffix) {
    let label = base + (suffix ? "_" + suffix : "")
    for (let i = 0;; i++) {
      let cur = i ? label + "_" + i : label
      if (!(cur in this.nodes) && !reserved.hasOwnProperty(cur)) {
        this.nodes[cur] = []
        return cur
      }
    }
  }

  edge(from, to, match, effects) {
    let edge = new Edge(to, match || nullMatch, effects)
    this.nodes[from].push(edge)
    return edge
  }

  gc() {
    let reached = this.forEachRef()
    for (let n in this.nodes) if (!(n in reached)) delete this.nodes[n]
  }

  forEachRef(f) {
    let reached = Object.create(null), work = []

    function reach(from, to, type) {
      if (f) f(from, to, type)
      if (!to || (to in reached)) return
      reached[to] = true
      work.push(to)
    }
    reach(null, this.start, "start")
    if (this.token) reach(null, this.token, "start")

    while (work.length) {
      let node = work.pop(), next = this.nodes[node]
      for (let i = 0; i < next.length; i++) {
        let edge = next[i]
        if (edge.to) reach(node, edge.to, "edge")
        if (edge.match instanceof LookaheadMatch)
          reach(node, edge.match.start, "lookahead")
        for (let j = 0; j < edge.effects.length; j++)
          if (edge.effects[j] instanceof CallEffect)
            reach(node, edge.effects[j].returnTo, "return")
      }
    }
    return reached
  }

  buildStartNode(first) {
    let cx = new LexicalContext(this, "START", noParams, null)
    let start = cx.node(), cur = start
    let skip = this.getSkipExpr(this.rules[first].skip)
    if (skip) {
      let next = cx.node()
      this.edge(cur, skip, null, [new CallEffect(next, "skip")])
      cur = next
    }
    cx.call(cur, start, first, none)
    return start
  }

  buildTokenNode(tokens) {
    let cx = new LexicalContext(this, "TOKEN", noParams, null)
    let start = cx.node(), end = cx.node("end")
    this.edge(end, null, null, [returnEffect])
    for (let i = 0; i < tokens.length; i++)
      cx.call(start, end, tokens[i], none)
    this.edge(start, end, anyMatch)
    return start
  }

  merge(a, b) {
    delete this.nodes[b]
    for (let node in this.nodes) {
      let edges = this.nodes[node]
      for (let i = 0; i < edges.length; i++) edges[i].merge(a, b)
    }
    for (let name in this.rules) {
      let instances = this.rules[name].instances
      for (let key in instances) if (instances[key] == b) instances[key].start = a
    }
    if (this.start == b) this.start = a
    if (this.token == b) this.token = a
  }

  toString() {
    let output = "digraph {\n"
    for (let node in this.nodes) {
      let edges = this.nodes[node]
      for (let i = 0; i < edges.length; i++)
        output += "  " + edges[i].toString(node) + ";\n"
    }
    return output + "}\n"
  }
}

class Edge {
  constructor(to, match, effects) {
    this.to = to
    this.match = match
    this.effects = effects || []
  }

  eq(other) {
    return this.to == other.to && this.match.eq(other.match) && eqArray(this.effects, other.effects)
  }

  merge(a, b) {
    if (this.to == b) this.to = a
    for (let i = 0; i < this.effects.length; i++) this.effects[i].merge(a, b)
    if (this.match instanceof LookaheadMatch && this.match.start == b) this.match.start = a
  }

  toString(from) {
    let result = `${from} -> ${this.to || "NULL"}`, label = this.match.regexp()
    if (this.effects.length) label = (label ? label + " " : "") + this.effects.join(" ")
    if (label) result += `[label=${JSON.stringify(label)}]`
    return result
  }
}

function forAllExprs(e, f) {
  f(e)
  if (e.exprs) for (let i = 0; i < e.exprs.length; i++) forAllExprs(e.exprs[i], f)
  if (e.expr) {
    forAllExprs(e.expr, f)
    if (e.type == "+") forAllExprs(e.expr, f) // The body of + is duplicated
  }
}

const CallEffect = exports.CallEffect = class {
  constructor(returnTo, name, hasContext) {
    this.returnTo = returnTo
    this.name = name
    this.hasContext = !!hasContext
  }

  eq(other) {
    return other instanceof CallEffect && other.hasContext == this.hasContext && other.returnTo == this.returnTo
  }

  merge(a, b) { if (this.returnTo == b) this.returnTo = a }

  toString() { return `call ${this.name} -> ${this.returnTo}` }
}

const returnEffect = exports.returnEffect = new class ReturnEffect {
  eq(other) { return other == this }

  merge() {}

  toString() { return "return" }
}

const PushContext = exports.PushContext = class {
  constructor(name, context, tokenType) {
    this.name = name
    this.context = context
    this.tokenType = tokenType
  }
  eq(other) { return other instanceof PushContext && other.name == this.name }
  merge() {}
  toString() { return `push ${this.name}` }
}

const popContext = exports.popContext = new class PopContext {
  eq(other) { return other == this }
  merge() {}
  toString() { return "pop" }
}

function rm(array, i) {
  let copy = array.slice()
  copy.splice(i, 1)
  return copy
}

function maybeSkipBefore(node, cx) {
  if (!cx.skip) return node
  let before = cx.node()
  cx.graph.edge(before, cx.skip, null, [new CallEffect(node, "skip")])
  return before
}

function compileSingleExpr(expr, cx) {
  let start = cx.node(), end = cx.node()
  generateExpr(start, end, expr, cx)
  cx.graph.edge(end, null, null, [returnEffect])
  return start
}

function generateExpr(start, end, expr, cx) {
  let t = expr.type, graph = cx.graph
  if (t == "CharacterRange") {
    graph.edge(start, end, new RangeMatch(expr.from, expr.to))
  } else if (t == "StringMatch") {
    let separated = expr.value.split(/\n\r?|\r/)
    for (let i = 0; i < separated.length - 1; i++) {
      let line = separated[i]
      if (line) {
        let after = cx.node()
        graph.edge(start, after, new StringMatch(line))
        start = after
      }
      let after = cx.node()
      graph.edge(start, after, new StringMatch("\n"))
      start = after
    }
    let last = separated[separated.length - 1]
    graph.edge(start, end, last ? new StringMatch(last) : nullMatch)
  } else if (t == "AnyMatch") {
    graph.edge(start, end, anyMatch)
  } else if (t == "DotMatch") {
    graph.edge(start, end, dotMatch)
  } else if (t == "RuleIdentifier") {
    cx.call(start, end, expr.id.name, expr.arguments.map(arg => compileSingleExpr(arg, cx)))
  } else if (t == "RepeatedMatch") {
    if (expr.kind == "*") {
      graph.edge(start, end)
      generateExpr(end, maybeSkipBefore(end, cx), expr.expr, cx)
    } else if (expr.kind == "+") {
      generateExpr(start, maybeSkipBefore(end, cx), expr.expr, cx)
      generateExpr(end, maybeSkipBefore(end, cx), expr.expr, cx)
    } else if (expr.kind == "?") {
      generateExpr(start, end, expr.expr, cx)
      graph.edge(start, end)
    }
  } else if (t == "LookaheadMatch") {
    let before = cx.node("lookahead"), after = cx.node("lookahead_end")
    generateExpr(before, after, expr.expr, cx)
    graph.edge(after, null, null, [returnEffect])
    graph.edge(start, end, new LookaheadMatch(before, t.kind == "~"))
  } else if (t == "SequenceMatch") {
    for (let i = 0; i < expr.exprs.length; i++) {
      let next = end, to = next, cur = expr.exprs[i]
      if (i < expr.exprs.length - 1) {
        next = cx.node()
        to = maybeSkipBefore(next, cx)
      }
      generateExpr(start, to, cur, cx)
      start = next
    }
  } else if (t == "ChoiceMatch") {
    for (let i = 0; i < expr.exprs.length; i++)
      generateExpr(start, end, expr.exprs[i], cx)
  } else {
    throw new Error("Unrecognized AST node type " + t)
  }
}

function lastCall(effects) {
  for (let i = effects.length - 1; i >= 0; i--)
    if (effects[i] instanceof CallEffect) return i
  return -1
}

function simplifySequence(graph, node, edges) {
  let changed = false
  outer: for (let i = 0; i < edges.length; i++) {
    let first = edges[i]
    if (first.to == node || first.to == graph.start || !first.to) continue
    let next = graph.nodes[first.to]
    if (next.length != 1) continue
    for (let j = 0; j < edges.length; j++)
      if (j != i && edges[j].to == first.to) continue outer
    let second = next[0], end = second.to, effects
    if (end == first.to ||
        (!first.match.isNull && (second.match.isolated || second.effects.some(e => e instanceof PushContext))) ||
        (!second.match.isNull && (first.match.isolated || first.effects.indexOf(popContext) > -1)))
      continue
    // If second is a return edge
    if (!end) {
      let last = lastCall(first.effects)
      if (last > -1 && !first.effects[last].hasContext) {
        // Matching non-context call found, wire directly to return address, remove call/return effects
        end = first.effects[last].returnTo
        effects = rm(first.effects, last).concat(second.effects.filter(e => e != returnEffect))
      }
    }
    edges[i] = new Edge(end, SeqMatch.create(first.match, second.match),
                        effects || first.effects.concat(second.effects))
    changed = true
  }
  return changed
}

function sameEffect(edge1, edge2) {
  let e1 = edge1.effects, e2 = edge2.effects
  if (e1.length != e2.length) return false
  for (let i = 0; i < e1.length; i++)
    if (!e1[i].eq(e2[i])) return false
  return true
}

function simplifyChoice(graph, node, edges) {
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i], set
    if (edge.match.isNull || edge.match.isolated) continue
    for (let j = i + 1; j < edges.length; j++) {
      let other = edges[j]
      if (other.to == edge.to && sameEffect(edge, other) && !other.match.isNull && !other.match.isolated)
        (set || (set = [edge])).push(other)
    }
    if (set) {
      let match = set[0].match
      for (let j = 1; j < set.length; j++)
        match = ChoiceMatch.create(match, set[j].match)
      graph.nodes[node] = edges.filter(e => set.indexOf(e) == -1).concat(new Edge(edge.to, match, edge.effects))
      return true
    }
  }
  return false
}

function simplifyRepeat(graph, node, edges) {
  if (node == graph.start) return
  let cycleIndex, cycleEdge
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i]
    if (edge.to == node && !edge.match.isolated && !edge.isNull) {
      if (cycleEdge) return false
      cycleIndex = i
      cycleEdge = edge
    }
  }
  if (!cycleEdge || cycleEdge.effects.length) return false
  let newNode = graph.node(node, "split")
  graph.nodes[newNode] = rm(edges, cycleIndex)
  graph.nodes[node] = [new Edge(newNode, new RepeatMatch(cycleEdge.match, "*"), cycleEdge.effects)]
  return true
}

function simplifyMaybe(_graph, _node, edges) {
  let changed = false
  outer: for (let i = 0; i < edges.length; i++) {
    let edge = edges[i]
    if (edge.match == nullMatch && edge.to) {
      let other = -1
      for (let j = 0; j < i; j++) if (edges[j].to == edge.to) {
        if (other > -1 || !eqArray(edge.effects, edges[j].effects) || edges[j].match.isNull) continue outer
        other = j
      }
      if (other == -1) continue
      edges[i--] = new Edge(edge.to, new RepeatMatch(edges[other].match, "?"), edge.effects)
      edges.splice(other, 1)
      changed = true
    }
  }
  return changed
}

function simplifyLookahead(graph, _node, edges) {
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i]
    if (!(edge.match instanceof LookaheadMatch)) continue
    let out = graph.nodes[edge.match.start]
    if (out.length != 1 || out[0].to || out[0].match.isolated) continue
    edges[i] = new Edge(edge.to, new SimpleLookaheadMatch(out[0].match, edge.match.positive), edge.effects)
    return true
  }
}

function isCalledOnlyOnce(graph, node) {
  let localNodes = [node], returnNodes = [], workIndex = 0
  while (workIndex < localNodes.length) {
    let cur = localNodes[workIndex++], edges = graph.nodes[cur]
    for (let i = 0; i < edges.length; i++) {
      let to = edges[i].to
      if (!to) returnNodes.push(cur)
      else if (localNodes.indexOf(to) == -1) localNodes.push(to)
    }
  }

  let called = 0
  graph.forEachRef((from, to, type) => {
    if (to != node || localNodes.indexOf(from) > -1) return
    called += (type == "edge" ? 1 : 100)
  })
  return called == 1 && returnNodes.length ? returnNodes : null
}

function simplifyCall(graph, _node, edges) {
  for (let i = 0; i < edges.length; i++) {
    let edge = edges[i], last = true
    for (let j = edge.effects.length - 1; j >= 0; j--) {
      let effect = edge.effects[j], returnNodes
      if (!(effect instanceof CallEffect)) continue
      if (last && (returnNodes = isCalledOnlyOnce(graph, edge.to))) { // FIXME this is very quadratic
        edges[i] = new Edge(edge.to, edge.match, rm(edge.effects, j))
        for (let k = 0; k < returnNodes.length; k++) {
          let edges = graph.nodes[returnNodes[k]]
          for (let l = 0; l < edges.length; l++) {
            let edge = edges[l]
            if (!edge.to) edges[l] = new Edge(effect.returnTo, edge.match, edge.effects.filter(e => e != returnEffect))
          }
        }
        return true
      }
      let out = graph.nodes[effect.returnTo]
      if (out.length != 1) continue
      let after = out[0]
      if (after.match != nullMatch) continue
      if (last && after.effects.length == 1 && after.effects[0] == returnEffect && !effect.hasContext) {
        // Change tail call to direct connection
        edges[i] = new Edge(edge.to, edge.match, rm(edge.effects, j))
        return true
      } else if (after.effects.length == 0) {
        // Erase a null edge after a call
        edge.effects[j] = new CallEffect(after.to, effect.name, effect.hasContext)
        return true
      }
      last = false
    }
  }
}

// Look for simplification possibilities around the given node, return
// true if anything was done
function simplifyWith(graph, simplifier) {
  let changed = false
  for (let node in graph.nodes)
    if (simplifier(graph, node, graph.nodes[node]))
      changed = true
  return changed
}

function simplify(graph) {
  for (;;) {
    while (simplifyWith(graph, simplifyChoice) |
           simplifyWith(graph, simplifyRepeat) |
           simplifyWith(graph, simplifyMaybe) |
           simplifyWith(graph, simplifyLookahead) |
           simplifyWith(graph, simplifySequence)) {}
    graph.gc()
    mergeDuplicates(graph)
    if (!simplifyWith(graph, simplifyCall)) break
  }
}

function mergeDuplicates(graph) {
  outer: for (;;) {
    let names = Object.keys(graph.nodes)
    for (let i = 0; i < names.length; i++) {
      let name = names[i], edges = graph.nodes[name]
      for (let j = i + 1; j < names.length; j++) {
        let otherName = names[j]
        if (eqArray(edges, graph.nodes[otherName])) {
          graph.merge(name, otherName)
          continue outer
        }
      }
    }
    break
  }
}

exports.buildGraph = function(grammar, options) {
  let graph = new Graph(grammar, options)
  simplify(graph)
  return graph
}
