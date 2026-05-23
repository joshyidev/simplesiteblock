# SimpleSiteBlock Wiki

Like the name suggests, SimpleSiteBlock is a simple site blocker for blocking distracting sites. It is not an ad blocker. It does not filter page resources, hide page elements, or modify requests after a page has
loaded.

The extension builds one compiled index from enabled lists and custom rules.
Allow rules are checked before block rules, so an allow rule can override a
matching block rule.

## Lists

Use **Update All** to fetch lists and rebuild the compiled index. When list
metadata changes, the Options page may show pending changes until the next
update or rebuild path runs.

### Hosts Lists

Hosts lists use hosts-file mapping lines. SimpleSiteBlock accepts mappings where
the first token is one of:

```text
0.0.0.0
127.0.0.1
::
::1
```

Examples:

```text
# Comments are ignored.
0.0.0.0 example.com
127.0.0.1 forum.example
```

Important behavior:

- Hosts entries are exact host blocks.
- `0.0.0.0 example.com` blocks `example.com`.
- It does not block `www.example.com`.
- Comments beginning with `#` are ignored.
- Local aliases such as `localhost`, `localhost.localdomain`, `broadcasthost`,
  and `local` are skipped.
- Hostnames are normalized to lowercase ASCII, so internationalized domains are
  converted to punycode.

### Adblock Lists

SimpleSiteBlock supports a practical subset of Adblock-style filter syntax.
This is the same syntax used by custom rules.

Supported examples:

```text
! Adblock comments are ignored.
# Hash comments are also ignored.

example.com
||example.org^
@@||allowed.example.org^
|https://cdn.example.com/feed/*
/video\d+\.js/
example.net # inline comments work after whitespace
```

Supported rule types:

- Bare domains, such as `example.com`, are exact host blocks.
- Host rules, such as `||example.com^`, block the domain and its subdomains.
- Allow rules start with `@@`.
- Pattern rules can use `*`, `^`, and `|`.
- Regex rules can be written as `/pattern/`.

Exact and subtree examples:

```text
example.com
||example.net^
```

`example.com` blocks only `example.com`. `||example.net^` blocks
`example.net`, `www.example.net`, and deeper subdomains.

Allow examples:

```text
||example.com^
@@||safe.example.com^
@@example.org
```

The first rule blocks `example.com` and its subdomains. The second allows
`safe.example.com` and its subdomains. The third allows exactly `example.org`.

Pattern examples:

```text
|https://example.com/private/*
example.com/profile^
forum*
```

Pattern rules are matched against the full URL. A leading `|` anchors the rule
to the beginning of the URL. A trailing `|` anchors it to the end. `*` matches
any characters. `^` matches a separator or the end of the URL.

Regex examples:

```text
/video\d+\.js/
@@/safe-path.*video/
```

Regex rules are case-insensitive by default. Stateful flags such as `g` and `y`
are stripped.

### Unsupported Or Skipped Adblock Syntax

SimpleSiteBlock intentionally skips rules it cannot apply to top-level
navigation blocking.

Skipped syntax includes:

- Cosmetic rules such as `example.com##.sidebar`, `#@#`, and `#?#`.
- Scriptlet-style rules containing `#%#`.
- Rules with unsupported options such as `$csp=`, `$rewrite=`,
  `$removeparam=`, `$redirect=`, `$replace=`, or `$permissions=`.
- Rules containing whitespace inside the rule body.
- Invalid regexes or patterns that cannot be compiled.

Other Adblock options after `$`, such as `$third-party`, are accepted but do not
change matching behavior. The rule target before `$` is what matters.

## Custom Rules

Custom rules are entered directly on the Options page. They use Adblock syntax,
not hosts-file syntax.

Good custom rules:

```text
example.com
||social.example^
@@||work.social.example^
|https://example.net/private/*
/feed-[0-9]+\.js/
```

Avoid hosts-file lines in custom rules:

```text
0.0.0.0 example.com
127.0.0.1 forum.example
```

Those are valid in hosts lists, but custom rules must use Adblock syntax. To
block an exact host in custom rules, write only the host:

```text
example.com
forum.example
```

To block a domain and every subdomain, use a subtree rule:

```text
||example.com^
```

To allow a blocked domain, prefix the matching rule with `@@`:

```text
@@||allowed.example.com^
```

Empty custom rules are allowed and simply clear the custom-rule portion of the
compiled index.

## Troubleshooting Lists

If a list fails to import or update:

- Confirm the URL returns plain text, not an HTML page.
- Lists must be 10 MB or smaller to download.
- Use hosts format only for real hosts-file mapping lines.
- Use Adblock format for bare domains, `||domain^` rules, allow rules, patterns,
  and regexes.
- Check for unsupported options or cosmetic filters if expected rules do not
  appear in the rule count.
