/*
  A small evaluator for the PURE helper functions in sql/service-v2.sql
  (norm_phone, phone_ok, …), so tests/sql-parity.test.js can run the SQL rule
  and the JS rule on the same inputs without a database.

  Not a test file itself (no .test.js), and not a SQL engine: it covers the
  shapes a pure helper is written in —

    language sql      select <expr> [from (select … as x) s] [where …]
    language plpgsql  declare v text := …; begin v := …; if … then …
                      elsif … else … end if; return …; end;

  with CASE, AND / OR / NOT (three-valued), = <> < > <= >=, BETWEEN, IN,
  LIKE, ~, ||, + - * /, ::casts, IS [NOT] NULL, and the text functions such a
  helper uses (length, left, right, substr, substring, regexp_replace,
  coalesce, …). Calls to other functions in the same file are followed.
  Anything else throws "sql-eval: …", so a helper rewritten in a shape this
  cannot read fails loudly instead of being skipped.

  Usage:
    var E = require('./sql-eval.js');
    var call = E.compile(sqlTextWithoutComments);
    call('norm_phone', ['+971 50 123 4567'])   // '971501234567'
*/
'use strict';

// ── tokens ──────────────────────────────────────────────────────────────────

var OPS = ['::', ':=', '||', '<=', '>=', '<>', '!=', '!~*', '!~', '~*', '~', '=', '<', '>', '+', '-', '*', '/', '%',
           '(', ')', ',', ';', '.', '[', ']'];

function tokenize(src) {
  var out = [], i = 0, n = src.length;
  while (i < n) {
    var c = src.charAt(i);
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || ((c === 'E' || c === 'e') && src.charAt(i + 1) === "'")) {
      var esc = c !== "'";
      if (esc) i++;
      var s = '';
      i++;
      while (i < n) {
        var ch = src.charAt(i);
        if (ch === "'") {
          if (src.charAt(i + 1) === "'") { s += "'"; i += 2; continue; }
          break;
        }
        if (esc && ch === '\\' && i + 1 < n) {
          var nx = src.charAt(i + 1);
          s += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          i += 2;
          continue;
        }
        s += ch;
        i++;
      }
      if (i >= n) throw new Error('sql-eval: unterminated string');
      i++;
      out.push({ t: 'str', v: s });
      continue;
    }
    if (/\d/.test(c)) {
      var m = /^\d+(\.\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '$' && /\d/.test(src.charAt(i + 1))) {
      var pm = /^\$(\d+)/.exec(src.slice(i));
      out.push({ t: 'param', v: Number(pm[1]) });
      i += pm[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      var w = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i))[0];
      out.push({ t: 'id', v: w.toLowerCase() });
      i += w.length;
      continue;
    }
    if (c === '"') {
      var e = src.indexOf('"', i + 1);
      if (e === -1) throw new Error('sql-eval: unterminated identifier');
      out.push({ t: 'id', v: src.slice(i + 1, e) });
      i = e + 1;
      continue;
    }
    var op = null;
    for (var k = 0; k < OPS.length; k++) {
      if (src.substr(i, OPS[k].length) === OPS[k]) { op = OPS[k]; break; }
    }
    if (!op) throw new Error('sql-eval: unexpected character ' + JSON.stringify(c));
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'eof', v: null });
  return out;
}

// Words that end an expression or a select list instead of naming an alias.
var RESERVED = ['from', 'where', 'into', 'then', 'else', 'end', 'when', 'and', 'or', 'not', 'is', 'in', 'as',
                'between', 'like', 'ilike', 'select', 'loop', 'elsif', 'elseif', 'if', 'return', 'group', 'order',
                'limit', 'union', 'for', 'using', 'on', 'join', 'cross', 'left', 'right'];

// ── parser ──────────────────────────────────────────────────────────────────

function Parser(tokens) { this.tk = tokens; this.i = 0; }
Parser.prototype.peek = function (o) { return this.tk[this.i + (o || 0)]; };
Parser.prototype.next = function () { return this.tk[this.i++]; };
Parser.prototype.isOp = function (v, o) { var t = this.peek(o); return t.t === 'op' && t.v === v; };
Parser.prototype.isWord = function (v, o) { var t = this.peek(o); return t.t === 'id' && t.v === v; };
Parser.prototype.eatOp = function (v) { if (this.isOp(v)) { this.i++; return true; } return false; };
Parser.prototype.eatWord = function (v) { if (this.isWord(v)) { this.i++; return true; } return false; };
Parser.prototype.expectOp = function (v) { if (!this.eatOp(v)) this.fail('expected "' + v + '"'); };
Parser.prototype.expectWord = function (v) { if (!this.eatWord(v)) this.fail('expected ' + v); };
Parser.prototype.fail = function (msg) {
  var t = this.peek();
  throw new Error('sql-eval: ' + msg + ' at ' + (t.t === 'eof' ? 'the end' : JSON.stringify(t.v)));
};
Parser.prototype.ident = function () {
  var t = this.next();
  if (t.t !== 'id') { this.i--; this.fail('expected a name'); }
  return t.v;
};

Parser.prototype.expr = function () { return this.or(); };
Parser.prototype.or = function () {
  var l = this.and();
  while (this.eatWord('or')) l = { k: 'or', a: l, b: this.and() };
  return l;
};
Parser.prototype.and = function () {
  var l = this.not();
  while (this.eatWord('and')) l = { k: 'and', a: l, b: this.not() };
  return l;
};
Parser.prototype.not = function () {
  if (this.eatWord('not')) return { k: 'not', a: this.not() };
  return this.is();
};
Parser.prototype.is = function () {
  var l = this.cmp();
  while (this.isWord('is')) {
    this.i++;
    var neg = this.eatWord('not');
    var what;
    if (this.eatWord('null')) what = 'null';
    else if (this.eatWord('true')) what = 'true';
    else if (this.eatWord('false')) what = 'false';
    else if (this.eatWord('distinct')) { this.expectWord('from'); l = { k: 'distinct', a: l, b: this.cmp(), neg: neg }; continue; }
    else this.fail('expected NULL, TRUE, FALSE or DISTINCT FROM after IS');
    l = { k: 'is', a: l, what: what, neg: neg };
  }
  return l;
};
var CMP = ['=', '<>', '!=', '<', '>', '<=', '>='];
Parser.prototype.cmp = function () {
  var l = this.range();
  while (this.peek().t === 'op' && CMP.indexOf(this.peek().v) !== -1) {
    var op = this.next().v;
    l = { k: 'bin', op: op === '!=' ? '<>' : op, a: l, b: this.range() };
  }
  return l;
};
Parser.prototype.range = function () {
  var l = this.other();
  for (;;) {
    var neg = false;
    if (this.isWord('not') && (this.isWord('between', 1) || this.isWord('in', 1) || this.isWord('like', 1) || this.isWord('ilike', 1))) {
      this.i++;
      neg = true;
    }
    if (this.eatWord('between')) {
      this.eatWord('symmetric');
      var lo = this.other();
      this.expectWord('and');
      l = { k: 'between', a: l, lo: lo, hi: this.other(), neg: neg };
    } else if (this.eatWord('in')) {
      this.expectOp('(');
      var list = [this.expr()];
      while (this.eatOp(',')) list.push(this.expr());
      this.expectOp(')');
      l = { k: 'in', a: l, list: list, neg: neg };
    } else if (this.isWord('like') || this.isWord('ilike')) {
      var ci = this.next().v === 'ilike';
      l = { k: 'like', a: l, b: this.other(), ci: ci, neg: neg };
    } else {
      if (neg) this.fail('expected BETWEEN, IN or LIKE after NOT');
      return l;
    }
  }
};
var OTHER = ['||', '~', '~*', '!~', '!~*'];
Parser.prototype.other = function () {
  var l = this.add();
  while (this.peek().t === 'op' && OTHER.indexOf(this.peek().v) !== -1) {
    var op = this.next().v;
    l = { k: 'bin', op: op, a: l, b: this.add() };
  }
  return l;
};
Parser.prototype.add = function () {
  var l = this.mul();
  while (this.isOp('+') || this.isOp('-')) { var op = this.next().v; l = { k: 'bin', op: op, a: l, b: this.mul() }; }
  return l;
};
Parser.prototype.mul = function () {
  var l = this.unary();
  while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { var op = this.next().v; l = { k: 'bin', op: op, a: l, b: this.unary() }; }
  return l;
};
Parser.prototype.unary = function () {
  if (this.eatOp('-')) return { k: 'neg', a: this.unary() };
  if (this.eatOp('+')) return this.unary();
  return this.postfix();
};
Parser.prototype.postfix = function () {
  var e = this.primary();
  while (this.eatOp('::')) {
    var type = this.ident();
    while (this.peek().t === 'id' && ['varying', 'precision', 'without', 'with', 'time', 'zone'].indexOf(this.peek().v) !== -1) type += ' ' + this.next().v;
    if (this.eatOp('(')) { while (!this.eatOp(')')) this.next(); }
    if (this.eatOp('[')) { this.expectOp(']'); type += '[]'; }
    e = { k: 'cast', a: e, type: type };
  }
  return e;
};
Parser.prototype.primary = function () {
  var t = this.peek();
  if (t.t === 'str') { this.i++; return { k: 'lit', v: t.v }; }
  if (t.t === 'num') { this.i++; return { k: 'lit', v: t.v }; }
  if (t.t === 'param') { this.i++; return { k: 'param', n: t.v }; }
  if (this.eatOp('(')) {
    if (this.isWord('select')) { var q = this.select(); this.expectOp(')'); return { k: 'subq', q: q }; }
    var e = this.expr();
    this.expectOp(')');
    return e;
  }
  if (t.t !== 'id') this.fail('unexpected token');
  if (this.eatWord('null')) return { k: 'lit', v: null };
  if (this.eatWord('true')) return { k: 'lit', v: true };
  if (this.eatWord('false')) return { k: 'lit', v: false };
  if (this.isWord('case')) return this.caseExpr();
  if (this.isWord('array') && this.isOp('[', 1)) {
    this.i += 2;
    var items = [];
    if (!this.isOp(']')) { items.push(this.expr()); while (this.eatOp(',')) items.push(this.expr()); }
    this.expectOp(']');
    return { k: 'array', items: items };
  }
  var name = this.ident();
  while (this.isOp('.') && this.peek(1).t === 'id') { this.i++; name += '.' + this.ident(); }
  if (this.eatOp('(')) return this.call(name);
  if (RESERVED.indexOf(name) !== -1) { this.i--; this.fail('unexpected keyword'); }
  return { k: 'ref', name: name };
};
Parser.prototype.call = function (name) {
  var args = [];
  var base = name.replace(/^(public|pg_catalog)\./, '');
  if (base === 'substring' || base === 'substr') {
    args.push(this.expr());
    if (this.eatWord('from')) {
      args.push(this.expr());
      if (this.eatWord('for')) args.push(this.expr());
      this.expectOp(')');
      return { k: 'call', name: 'substr', args: args };
    }
  } else if (base === 'position') {
    var needle = this.other();
    this.expectWord('in');
    var hay = this.expr();
    this.expectOp(')');
    return { k: 'call', name: 'strpos', args: [hay, needle] };
  } else if (!this.isOp(')')) {
    args.push(this.expr());
  }
  while (this.eatOp(',')) args.push(this.expr());
  this.expectOp(')');
  return { k: 'call', name: name, args: args };
};
Parser.prototype.caseExpr = function () {
  this.expectWord('case');
  var subject = this.isWord('when') ? null : this.expr();
  var arms = [];
  while (this.eatWord('when')) {
    var w = this.expr();
    this.expectWord('then');
    arms.push({ w: w, t: this.expr() });
  }
  if (!arms.length) this.fail('CASE without WHEN');
  var els = this.eatWord('else') ? this.expr() : null;
  this.expectWord('end');
  return { k: 'case', subject: subject, arms: arms, els: els };
};
// select <targets> [into v] [from (select …) alias [(cols)]] [where …]
Parser.prototype.select = function () {
  this.expectWord('select');
  var targets = [], into = null;
  do {
    var e = this.expr(), as = null;
    if (this.eatWord('as')) as = this.ident();
    else if (this.peek().t === 'id' && RESERVED.indexOf(this.peek().v) === -1) as = this.ident();
    targets.push({ e: e, as: as || (e.k === 'ref' ? e.name.split('.').pop() : e.k === 'call' ? e.name.split('.').pop() : '?column?') });
  } while (this.eatOp(','));
  if (this.eatWord('into')) { this.eatWord('strict'); into = this.ident(); }
  var from = null;
  if (this.eatWord('from')) {
    this.expectOp('(');
    if (!this.isWord('select')) this.fail('only FROM (SELECT …) is supported');
    var q = this.select();
    this.expectOp(')');
    this.eatWord('as');
    var alias = this.peek().t === 'id' && RESERVED.indexOf(this.peek().v) === -1 ? this.ident() : null;
    var cols = null;
    if (alias && this.eatOp('(')) { cols = [this.ident()]; while (this.eatOp(',')) cols.push(this.ident()); this.expectOp(')'); }
    from = { q: q, alias: alias, cols: cols };
  }
  var where = this.eatWord('where') ? this.expr() : null;
  return { targets: targets, into: into, from: from, where: where };
};

// plpgsql: [declare …] begin … end
Parser.prototype.block = function () {
  var decls = [];
  if (this.eatWord('declare')) {
    while (!this.isWord('begin')) {
      if (this.peek().t === 'eof') this.fail('DECLARE without BEGIN');
      var name = this.ident();
      this.eatWord('constant');
      var depth = 0;           // the type: everything up to := / = / default / ;
      while (depth > 0 || !(this.isOp(':=') || this.isOp('=') || this.isWord('default') || this.isOp(';'))) {
        if (this.peek().t === 'eof') this.fail('unterminated declaration');
        if (this.isOp('(')) depth++;
        if (this.isOp(')')) depth--;
        this.i++;
      }
      var init = null;
      if (this.eatOp(':=') || this.eatOp('=') || this.eatWord('default')) init = this.expr();
      this.expectOp(';');
      decls.push({ name: name, init: init });
    }
  }
  this.expectWord('begin');
  var body = this.stmts(['end']);
  this.expectWord('end');
  this.eatOp(';');
  return { decls: decls, body: body };
};
Parser.prototype.stmts = function (enders) {
  var out = [];
  for (;;) {
    var t = this.peek();
    if (t.t === 'eof') this.fail('unterminated block');
    if (t.t === 'id' && enders.indexOf(t.v) !== -1) return out;
    out.push(this.stmt());
  }
};
Parser.prototype.stmt = function () {
  if (this.eatWord('if')) {
    var branches = [];
    var c = this.expr();
    this.expectWord('then');
    branches.push({ c: c, body: this.stmts(['elsif', 'elseif', 'else', 'end']) });
    var els = null;
    for (;;) {
      if (this.eatWord('elsif') || this.eatWord('elseif')) {
        var c2 = this.expr();
        this.expectWord('then');
        branches.push({ c: c2, body: this.stmts(['elsif', 'elseif', 'else', 'end']) });
      } else if (this.eatWord('else')) {
        els = this.stmts(['end']);
      } else break;
    }
    this.expectWord('end');
    this.expectWord('if');
    this.expectOp(';');
    return { k: 'if', branches: branches, els: els };
  }
  if (this.eatWord('return')) {
    var e = this.isOp(';') ? { k: 'lit', v: null } : this.expr();
    this.expectOp(';');
    return { k: 'return', e: e };
  }
  if (this.isWord('select')) {
    var q = this.select();
    if (!q.into) this.fail('SELECT without INTO in a function body');
    this.expectOp(';');
    return { k: 'selinto', q: q };
  }
  if (this.eatWord('null')) { this.expectOp(';'); return { k: 'noop' }; }
  if (this.peek().t === 'id' && (this.isOp(':=', 1) || this.isOp('=', 1))) {
    var name = this.ident();
    this.next();
    var v = this.expr();
    this.expectOp(';');
    return { k: 'assign', name: name, e: v };
  }
  this.fail('unsupported statement');
};

// ── evaluation (PostgreSQL semantics for the pieces above) ──────────────────

function likeToRe(p, ci) {
  var s = '';
  for (var i = 0; i < p.length; i++) {
    var c = p.charAt(i);
    if (c === '\\' && i + 1 < p.length) { s += p.charAt(++i).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); continue; }
    if (c === '%') s += '[\\s\\S]*';
    else if (c === '_') s += '[\\s\\S]';
    else s += c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }
  return new RegExp('^' + s + '$', ci ? 'i' : '');
}
// POSIX classes the helpers might use; the rest of an ARE pattern this simple
// reads the same in JavaScript.
function posixToRe(p, flags) {
  var s = String(p)
    .replace(/\[:digit:\]/g, '0-9').replace(/\[:alpha:\]/g, 'A-Za-z').replace(/\[:alnum:\]/g, 'A-Za-z0-9')
    .replace(/\[:space:\]/g, '\\s').replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z');
  return new RegExp(s, flags);
}
function isNull(v) { return v === null || v === undefined; }
function text(v) { return v === true ? 'true' : v === false ? 'false' : String(v); }
function cmpVals(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  var x = text(a), y = text(b);
  if (typeof a === 'number' || typeof b === 'number') {
    var nx = Number(x), ny = Number(y);
    if (!isNaN(nx) && !isNaN(ny)) return nx < ny ? -1 : nx > ny ? 1 : 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;   // the C collation; the helpers compare digits only
}
function int(v) {
  var n = typeof v === 'number' ? v : Number(text(v).trim());
  if (isNaN(n)) throw new Error('sql-eval: invalid integer ' + JSON.stringify(v));
  return Math.trunc(n);
}

var STRICT_FNS = {
  length: function (s) { return text(s).length; },
  char_length: function (s) { return text(s).length; },
  character_length: function (s) { return text(s).length; },
  lower: function (s) { return text(s).toLowerCase(); },
  upper: function (s) { return text(s).toUpperCase(); },
  left: function (s, n) {
    s = text(s); n = int(n);
    return n >= 0 ? s.slice(0, n) : s.slice(0, Math.max(0, s.length + n));
  },
  right: function (s, n) {
    s = text(s); n = int(n);
    return n >= 0 ? (n === 0 ? '' : s.slice(-n)) : s.slice(Math.min(s.length, -n));
  },
  substr: function (s, start, count) {
    s = text(s); start = int(start);
    if (count === undefined) return s.slice(Math.max(start, 1) - 1);
    count = int(count);
    if (count < 0) throw new Error('sql-eval: negative substring length not allowed');
    var end = start + count;
    return s.slice(Math.max(start, 1) - 1, Math.max(end, 1) - 1);
  },
  strpos: function (s, sub) { return text(s).indexOf(text(sub)) + 1; },
  starts_with: function (s, p) { return text(s).indexOf(text(p)) === 0; },
  replace: function (s, a, b) { return text(s).split(text(a)).join(text(b)); },
  translate: function (s, from, to) {
    s = text(s); from = text(from); to = text(to);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var k = from.indexOf(s.charAt(i));
      out += k === -1 ? s.charAt(i) : (k < to.length ? to.charAt(k) : '');
    }
    return out;
  },
  btrim: function (s, chars) { return trimChars(text(s), chars, true, true); },
  ltrim: function (s, chars) { return trimChars(text(s), chars, true, false); },
  rtrim: function (s, chars) { return trimChars(text(s), chars, false, true); },
  regexp_replace: function (s, pat, rep, flags) {
    flags = flags === undefined ? '' : text(flags);
    var g = flags.indexOf('g') !== -1, ci = flags.indexOf('i') !== -1;
    var re = posixToRe(text(pat), (g ? 'g' : '') + (ci ? 'i' : ''));
    var r = text(rep).replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/\\&/g, '$$&');
    return text(s).replace(re, r);
  },
  abs: function (n) { return Math.abs(Number(n)); }
};
function trimChars(s, chars, l, r) {
  var set = chars === undefined ? ' ' : text(chars);
  var a = 0, b = s.length;
  if (l) while (a < b && set.indexOf(s.charAt(a)) !== -1) a++;
  if (r) while (b > a && set.indexOf(s.charAt(b - 1)) !== -1) b--;
  return s.slice(a, b);
}
STRICT_FNS.trim = STRICT_FNS.btrim;
STRICT_FNS.substring = STRICT_FNS.substr;

function Interp(fns) { this.fns = fns; this.depth = 0; }

Interp.prototype.call = function (name, args) {
  var f = this.fns[name];
  if (!f) throw new Error('sql-eval: function ' + name + '() not found in the file');
  if (++this.depth > 50) throw new Error('sql-eval: recursion too deep in ' + name + '()');
  try {
    var env = { vars: {}, params: args };
    f.params.forEach(function (p, i) { env.vars[p] = isNull(args[i]) ? null : args[i]; });
    if (f.kind === 'sql') {
      var v = this.select(f.ast, env);
      return v;
    }
    var self = this;
    f.ast.decls.forEach(function (d) { env.vars[d.name] = d.init ? self.ev(d.init, env) : null; });
    var r = this.run(f.ast.body, env);
    return r ? r.value : null;
  } finally {
    this.depth--;
  }
};

Interp.prototype.run = function (stmts, env) {
  for (var i = 0; i < stmts.length; i++) {
    var s = stmts[i], r;
    if (s.k === 'assign') {
      if (!(s.name in env.vars)) throw new Error('sql-eval: assignment to undeclared ' + s.name);
      env.vars[s.name] = this.ev(s.e, env);
    } else if (s.k === 'return') {
      return { value: this.ev(s.e, env) };
    } else if (s.k === 'selinto') {
      if (!(s.q.into in env.vars)) throw new Error('sql-eval: SELECT INTO undeclared ' + s.q.into);
      env.vars[s.q.into] = this.select(s.q, env);
    } else if (s.k === 'if') {
      var done = false;
      for (var b = 0; b < s.branches.length && !done; b++) {
        if (this.ev(s.branches[b].c, env) === true) {
          done = true;
          r = this.run(s.branches[b].body, env);
          if (r) return r;
        }
      }
      if (!done && s.els) { r = this.run(s.els, env); if (r) return r; }
    }
  }
  return null;
};

// One row, first column (a scalar subquery / a sql function body). No row
// (a WHERE that is not true) is NULL, as in PostgreSQL.
Interp.prototype.select = function (q, env) {
  var r = this.row(q, env);
  return r ? r[0].value : null;
};
// The row of `select <targets> [from (select …) alias] [where …]`, as
// [{name, value}], or null when the WHERE drops it.
Interp.prototype.row = function (q, env) {
  var scope = env;
  if (q.from) {
    scope = { vars: Object.create(env.vars), params: env.params };
    var row = this.row(q.from.q, { vars: Object.create(env.vars), params: env.params });
    if (!row) return null;
    row.forEach(function (c, i) {
      var nm = q.from.cols && q.from.cols[i] ? q.from.cols[i] : c.name;
      scope.vars[nm] = c.value;
      if (q.from.alias) scope.vars[q.from.alias + '.' + nm] = c.value;
    });
  }
  if (q.where && this.ev(q.where, scope) !== true) return null;
  var self = this;
  return q.targets.map(function (t) { return { name: t.as, value: self.ev(t.e, scope) }; });
};

Interp.prototype.ev = function (n, env) {
  var self = this, a, b;
  switch (n.k) {
    case 'lit': return n.v;
    case 'param': return isNull(env.params[n.n - 1]) ? null : env.params[n.n - 1];
    case 'ref': {
      if (n.name in env.vars) return env.vars[n.name];
      var tail = n.name.split('.').pop();
      if (n.name.indexOf('.') !== -1 && tail in env.vars) return env.vars[tail];
      throw new Error('sql-eval: unknown name ' + n.name);
    }
    case 'subq': return this.select(n.q, env);
    case 'array': return n.items.map(function (x) { return self.ev(x, env); });
    case 'neg': a = this.ev(n.a, env); return isNull(a) ? null : -Number(a);
    case 'not': a = this.ev(n.a, env); return isNull(a) ? null : !a;
    case 'and':
      a = this.ev(n.a, env);
      if (a === false) return false;
      b = this.ev(n.b, env);
      if (b === false) return false;
      return isNull(a) || isNull(b) ? null : true;
    case 'or':
      a = this.ev(n.a, env);
      if (a === true) return true;
      b = this.ev(n.b, env);
      if (b === true) return true;
      return isNull(a) || isNull(b) ? null : false;
    case 'is': {
      a = this.ev(n.a, env);
      var r = n.what === 'null' ? isNull(a) : n.what === 'true' ? a === true : a === false;
      return n.neg ? !r : r;
    }
    case 'distinct': {
      a = this.ev(n.a, env); b = this.ev(n.b, env);
      var d = (isNull(a) !== isNull(b)) || (!isNull(a) && cmpVals(a, b) !== 0);
      return n.neg ? !d : d;
    }
    case 'between': {
      a = this.ev(n.a, env);
      var lo = this.ev(n.lo, env), hi = this.ev(n.hi, env);
      if (isNull(a) || isNull(lo) || isNull(hi)) return null;
      var inr = cmpVals(a, lo) >= 0 && cmpVals(a, hi) <= 0;
      return n.neg ? !inr : inr;
    }
    case 'in': {
      a = this.ev(n.a, env);
      if (isNull(a)) return null;
      var sawNull = false, hit = false;
      n.list.forEach(function (x) {
        var v = self.ev(x, env);
        if (isNull(v)) sawNull = true;
        else if (cmpVals(a, v) === 0) hit = true;
      });
      if (hit) return !n.neg;
      return sawNull ? null : !!n.neg;
    }
    case 'like': {
      a = this.ev(n.a, env); b = this.ev(n.b, env);
      if (isNull(a) || isNull(b)) return null;
      var m = likeToRe(text(b), n.ci).test(text(a));
      return n.neg ? !m : m;
    }
    case 'case': {
      var subj = n.subject ? this.ev(n.subject, env) : undefined;
      for (var i = 0; i < n.arms.length; i++) {
        var w = this.ev(n.arms[i].w, env);
        var hitArm = n.subject ? (!isNull(subj) && !isNull(w) && cmpVals(subj, w) === 0) : w === true;
        if (hitArm) return this.ev(n.arms[i].t, env);
      }
      return n.els ? this.ev(n.els, env) : null;
    }
    case 'cast': {
      a = this.ev(n.a, env);
      if (isNull(a)) return null;
      if (/^(int|integer|int4|int8|bigint|smallint)$/.test(n.type)) return int(a);
      if (/^(numeric|decimal|real|float|double precision)/.test(n.type)) return Number(a);
      if (/^(bool|boolean)$/.test(n.type)) {
        var tv = text(a).toLowerCase();
        if (['t', 'true', 'yes', 'on', '1'].indexOf(tv) !== -1) return true;
        if (['f', 'false', 'no', 'off', '0'].indexOf(tv) !== -1) return false;
        throw new Error('sql-eval: invalid boolean ' + JSON.stringify(a));
      }
      if (/^(text|varchar|character varying|char|bpchar)/.test(n.type)) return text(a);
      throw new Error('sql-eval: cast to ' + n.type + ' is not supported');
    }
    case 'bin': {
      a = this.ev(n.a, env); b = this.ev(n.b, env);
      if (isNull(a) || isNull(b)) return null;
      switch (n.op) {
        case '||': return text(a) + text(b);
        case '=': return cmpVals(a, b) === 0;
        case '<>': return cmpVals(a, b) !== 0;
        case '<': return cmpVals(a, b) < 0;
        case '>': return cmpVals(a, b) > 0;
        case '<=': return cmpVals(a, b) <= 0;
        case '>=': return cmpVals(a, b) >= 0;
        case '~': return posixToRe(text(b), '').test(text(a));
        case '~*': return posixToRe(text(b), 'i').test(text(a));
        case '!~': return !posixToRe(text(b), '').test(text(a));
        case '!~*': return !posixToRe(text(b), 'i').test(text(a));
        case '+': return Number(a) + Number(b);
        case '-': return Number(a) - Number(b);
        case '*': return Number(a) * Number(b);
        case '/': if (Number(b) === 0) throw new Error('sql-eval: division by zero'); return Math.trunc(Number(a) / Number(b));
        case '%': return Number(a) % Number(b);
      }
      throw new Error('sql-eval: operator ' + n.op);
    }
    case 'call': {
      var base = n.name.replace(/^(public|pg_catalog)\./, '');
      var args = n.args.map(function (x) { return self.ev(x, env); });
      if (base === 'coalesce') { for (var j = 0; j < args.length; j++) if (!isNull(args[j])) return args[j]; return null; }
      if (base === 'nullif') return !isNull(args[0]) && !isNull(args[1]) && cmpVals(args[0], args[1]) === 0 ? null : args[0];
      if (base === 'concat') return args.filter(function (x) { return !isNull(x); }).map(text).join('');
      if (base === 'greatest' || base === 'least') {
        var vals = args.filter(function (x) { return !isNull(x); });
        if (!vals.length) return null;
        return vals.reduce(function (p, c) { return (base === 'greatest' ? cmpVals(c, p) > 0 : cmpVals(c, p) < 0) ? c : p; });
      }
      if (this.fns[base]) return this.call(base, args);
      if (STRICT_FNS[base]) {
        if (args.some(isNull)) return null;
        return STRICT_FNS[base].apply(null, args);
      }
      throw new Error('sql-eval: function ' + n.name + '() is not supported');
    }
  }
  throw new Error('sql-eval: cannot evaluate ' + n.k);
};

// ── reading the file ────────────────────────────────────────────────────────

// Every `create [or replace] function name(params) … as $$ body $$` in the
// (comment-free) SQL; the LAST definition of a name wins, like the database.
// Bodies are parsed lazily, so a function this cannot read only matters when
// a test calls it.
function compile(sql) {
  var defs = {};
  var re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi, m;
  while ((m = re.exec(sql)) !== null) {
    var open = re.lastIndex - 1, depth = 0, close = -1;
    for (var i = open; i < sql.length; i++) {
      if (sql.charAt(i) === '(') depth++;
      else if (sql.charAt(i) === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close === -1) continue;
    var a = sql.indexOf('$$', close);
    var b = a === -1 ? -1 : sql.indexOf('$$', a + 2);
    if (b === -1) continue;
    var head = sql.slice(close + 1, a);
    var params = sql.slice(open + 1, close).split(',').map(function (p) {
      var words = p.trim().split(/\s+/).filter(Boolean);
      if (words.length && /^(in|out|inout|variadic)$/i.test(words[0])) words.shift();
      return words.length ? words[0].toLowerCase() : null;
    }).filter(Boolean);
    var lang = /\blanguage\s+plpgsql\b/i.test(head) || /\blanguage\s+plpgsql\b/i.test(sql.slice(b, b + 200).split(';')[0])
      ? 'plpgsql' : 'sql';
    defs[m[1].toLowerCase()] = { src: sql.slice(a + 2, b), params: params, kind: lang };
  }
  var fns = {};
  Object.keys(defs).forEach(function (name) {
    var d = defs[name], parsed = null;
    Object.defineProperty(fns, name, {
      enumerable: true,
      get: function () {
        if (parsed) return parsed;
        var p = new Parser(tokenize(d.src));
        var ast;
        if (d.kind === 'plpgsql') ast = p.block();
        else { ast = p.select(); p.eatOp(';'); }
        if (p.peek().t !== 'eof') p.fail('unexpected text after the body of ' + name + '()');
        parsed = { kind: d.kind, params: d.params, ast: ast };
        return parsed;
      }
    });
  });
  var interp = new Interp(fns);
  function call(name, args) { return interp.call(String(name).toLowerCase(), args || []); }
  call.has = function (name) { return Object.prototype.hasOwnProperty.call(defs, String(name).toLowerCase()); };
  return call;
}

module.exports = { compile: compile, tokenize: tokenize };
