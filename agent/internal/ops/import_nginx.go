package ops

// Parser nginx tối thiểu cho import (D-108, ADR 0053 §2): chỉ tách token và khối, lấy các directive cần cho kế hoạch
// import (server_name, root, listen, ssl_certificate, include, fastcgi_pass, proxy_pass). KHÔNG theo `include`
// (chỉ ghi lại tên để đoán phiên bản PHP của aaPanel), giới hạn kích thước file, số token và độ sâu khối.

import (
	"errors"
	"regexp"
	"strings"
)

const (
	nginxMaxFile   = 256 << 10
	nginxMaxTokens = 50_000
	nginxMaxDepth  = 16
)

type nginxDirective struct {
	name  string
	args  []string
	block []nginxDirective
}

// nginxServer là thông tin rút từ một khối server.
type nginxServer struct {
	names    []string
	root     string
	ssl      bool
	cert     string
	phpVer   string
	proxy    bool
	includes []string
}

var errNginxParse = errors.New("cấu hình nginx không đọc được")

// tokenizeNginx tách token: từ, chuỗi trong nháy, `;`, `{`, `}`; bỏ comment.
func tokenizeNginx(b []byte) ([]string, error) {
	if len(b) > nginxMaxFile {
		return nil, errors.New("file vhost lớn hơn 256 KB")
	}
	var toks []string
	s := string(b)
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '#':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == ';' || c == '{' || c == '}':
			toks = append(toks, string(c))
			i++
		case c == '"' || c == '\'':
			q := c
			j := i + 1
			var sb strings.Builder
			for j < len(s) && s[j] != q {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				sb.WriteByte(s[j])
				j++
			}
			if j >= len(s) {
				return nil, errNginxParse
			}
			toks = append(toks, sb.String())
			i = j + 1
		default:
			j := i
			for j < len(s) && !strings.ContainsRune(" \t\n\r;{}#\"'", rune(s[j])) {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				j++
			}
			if j > len(s) {
				j = len(s)
			}
			toks = append(toks, s[i:j])
			i = j
		}
		if len(toks) > nginxMaxTokens {
			return nil, errors.New("file vhost quá nhiều token")
		}
	}
	return toks, nil
}

// parseNginx dựng cây directive.
func parseNginx(b []byte) ([]nginxDirective, error) {
	toks, err := tokenizeNginx(b)
	if err != nil {
		return nil, err
	}
	pos := 0
	var parse func(depth int) ([]nginxDirective, error)
	parse = func(depth int) ([]nginxDirective, error) {
		if depth > nginxMaxDepth {
			return nil, errors.New("khối nginx lồng quá sâu")
		}
		var out []nginxDirective
		for pos < len(toks) {
			t := toks[pos]
			if t == "}" {
				if depth == 0 {
					return nil, errNginxParse
				}
				pos++
				return out, nil
			}
			if t == ";" || t == "{" {
				return nil, errNginxParse
			}
			d := nginxDirective{name: t}
			pos++
			for pos < len(toks) && toks[pos] != ";" && toks[pos] != "{" && toks[pos] != "}" {
				d.args = append(d.args, toks[pos])
				pos++
			}
			if pos >= len(toks) || toks[pos] == "}" {
				return nil, errNginxParse
			}
			if toks[pos] == "{" {
				pos++
				blk, err := parse(depth + 1)
				if err != nil {
					return nil, err
				}
				d.block = blk
				if d.block == nil {
					d.block = []nginxDirective{}
				}
			} else {
				pos++
			}
			out = append(out, d)
		}
		if depth != 0 {
			return nil, errNginxParse
		}
		return out, nil
	}
	return parse(0)
}

var (
	reAaPHPInclude = regexp.MustCompile(`^enable-php-([5-8])([0-9])\.conf$`)
	reFastcgiSock  = regexp.MustCompile(`php-?(?:cgi-)?([5-8])\.?([0-9])(?:-fpm)?\.sock$|php([5-8])\.([0-9])-fpm`)
)

// nginxServers trả các khối server (ở gốc hoặc trong http).
func nginxServers(b []byte) ([]nginxServer, error) {
	tree, err := parseNginx(b)
	if err != nil {
		return nil, err
	}
	var out []nginxServer
	var walk func(ds []nginxDirective)
	walk = func(ds []nginxDirective) {
		for _, d := range ds {
			switch {
			case d.name == "server" && d.block != nil:
				out = append(out, serverInfo(d.block))
			case d.name == "http" && d.block != nil:
				walk(d.block)
			}
		}
	}
	walk(tree)
	return out, nil
}

func serverInfo(ds []nginxDirective) nginxServer {
	var s nginxServer
	var inner func(ds []nginxDirective, top bool)
	inner = func(ds []nginxDirective, top bool) {
		for _, d := range ds {
			switch d.name {
			case "server_name":
				if top {
					s.names = append(s.names, d.args...)
				}
			case "root":
				if top && s.root == "" && len(d.args) == 1 {
					s.root = d.args[0]
				}
			case "listen":
				if top {
					for _, a := range d.args {
						if a == "ssl" || strings.HasSuffix(a, ":443") || a == "443" {
							s.ssl = true
						}
					}
				}
			case "ssl_certificate":
				if top && len(d.args) == 1 {
					s.cert = d.args[0]
				}
			case "include":
				for _, a := range d.args {
					s.includes = append(s.includes, a)
					base := a[strings.LastIndexByte(a, '/')+1:]
					if m := reAaPHPInclude.FindStringSubmatch(base); m != nil && s.phpVer == "" {
						s.phpVer = m[1] + "." + m[2]
					}
				}
			case "fastcgi_pass":
				if len(d.args) == 1 && s.phpVer == "" {
					if m := reFastcgiSock.FindStringSubmatch(d.args[0]); m != nil {
						if m[1] != "" {
							s.phpVer = m[1] + "." + m[2]
						} else {
							s.phpVer = m[3] + "." + m[4]
						}
					}
				}
			case "proxy_pass", "uwsgi_pass", "grpc_pass":
				s.proxy = true
			}
			if d.block != nil {
				inner(d.block, false)
			}
		}
	}
	inner(ds, true)
	return s
}
