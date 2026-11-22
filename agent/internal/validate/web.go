package validate

import (
	"regexp"
	"strings"
)

// Validator cho giá trị đi vào cấu hình Nginx, PHP-FPM và argv của lego (Phase 5, D-67…D-69).
// Mẫu trùng với contracts/agent-ops/defs.schema.json; Go kiểm lại để không tin panel.

var (
	reDomain   = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$`)
	reSize     = regexp.MustCompile(`^[0-9]{1,5}[kmg]?$`)
	reHeader   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{1,63}$`)
	reURLPath  = regexp.MustCompile(`^/[A-Za-z0-9._~%/-]*$`)
	reRedirect = regexp.MustCompile(`^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?(/[A-Za-z0-9._~%/-]*)?$`)
	reEmail    = regexp.MustCompile(`^[A-Za-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	reFunc     = regexp.MustCompile(`^[a-z_0-9]+$`)
	reUUID     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	rePHPVer   = regexp.MustCompile(`^[5-9]\.[0-9]$`)
)

// reservedDomains: tên nội bộ không bao giờ phục vụ như website (vector semantic).
var reservedDomainSuffix = []string{"localhost", "localdomain", "local", "internal", "invalid", "test", "example.invalid"}

// PHPSupported là phiên bản PHP agent quản lý: 8.3 từ kho Ubuntu 24.04 (D-68); 8.1/8.2/8.4 từ PPA ondrej/php
// có khóa ghim (Phase 10, D-100).
var PHPSupported = map[string]bool{"8.1": true, "8.2": true, "8.3": true, "8.4": true}

// PHPFromPPA: phiên bản cần kho PPA ondrej/php.
var PHPFromPPA = map[string]bool{"8.1": true, "8.2": true, "8.4": true}

// PHPExtensions là allowlist extension → tên gói apt (php<ver>-<ext>).
var PHPExtensions = map[string]bool{"bcmath": true, "curl": true, "gd": true, "imagick": true, "intl": true, "mbstring": true,
	"mysql": true, "opcache": true, "pgsql": true, "redis": true, "soap": true, "sqlite3": true, "xml": true, "zip": true}

// Domain kiểm domain website (chữ thường, punycode, không wildcard, không tên nội bộ).
func Domain(d string) error {
	if len(d) < 4 || len(d) > 253 || !reDomain.MatchString(d) {
		return bad("domain", "domain không hợp lệ: %q", d)
	}
	labels := strings.Split(d, ".")
	tld := labels[len(labels)-1]
	for _, r := range reservedDomainSuffix {
		if tld == r || strings.HasSuffix(d, "."+r) {
			return &Error{Code: "reserved_name", Field: "domain", Msg: "tên miền nội bộ không dùng cho website"}
		}
	}
	return nil
}

// Domains kiểm danh sách domain (không trùng, giới hạn số lượng).
func Domains(ds []string, min, max int) error {
	if len(ds) < min || len(ds) > max {
		return bad("domains", "cần %d–%d domain", min, max)
	}
	seen := map[string]bool{}
	for _, d := range ds {
		if err := Domain(d); err != nil {
			return err
		}
		if seen[d] {
			return bad("domains", "domain trùng: %s", d)
		}
		seen[d] = true
	}
	return nil
}

// RelPath kiểm đường dẫn tương đối (không tuyệt đối, không `..`, không ký tự điều khiển, không ký tự phá cú pháp Nginx).
func RelPath(p string) error {
	if p == "." {
		return nil
	}
	if p == "" || len(p) > 4096 || strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") {
		return bad("path", "đường dẫn tương đối không hợp lệ")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return bad("path", "đường dẫn có thành phần cấm: %q", seg)
		}
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(" ;{}\"'\\$#", r) {
			return bad("path", "đường dẫn có ký tự cấm")
		}
	}
	return nil
}

// NginxSize kiểm kích thước dạng Nginx (64m, 1g).
func NginxSize(s string) error {
	if !reSize.MatchString(s) {
		return bad("size", "kích thước không hợp lệ: %q", s)
	}
	return nil
}

// HeaderName / HeaderValue kiểm header thêm vào vhost (cấm ký tự phá cú pháp, CRLF, biến $).
func HeaderName(s string) error {
	if !reHeader.MatchString(s) {
		return bad("extra_headers", "tên header không hợp lệ: %q", s)
	}
	return nil
}

func HeaderValue(s string) error {
	if len(s) > 512 {
		return bad("extra_headers", "giá trị header quá dài")
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(";{}\"'\\$", r) {
			return bad("extra_headers", "giá trị header có ký tự cấm")
		}
	}
	return nil
}

// URLPath kiểm đường dẫn URL của redirect.
func URLPath(s string) error {
	if len(s) > 512 || !reURLPath.MatchString(s) {
		return bad("redirects.from", "đường dẫn URL không hợp lệ: %q", s)
	}
	return nil
}

// RedirectTarget kiểm URL đích redirect.
func RedirectTarget(s string) error {
	if len(s) > 1024 || !reRedirect.MatchString(s) {
		return bad("redirects.to", "URL đích không hợp lệ")
	}
	return nil
}

// Email kiểm email cho ACME (đi vào argv lego dạng --email=<giá trị>).
func Email(s string) error {
	if len(s) > 190 || !reEmail.MatchString(s) || strings.HasPrefix(s, "-") {
		return bad("email", "email không hợp lệ")
	}
	return nil
}

// UUID kiểm uuid chữ thường.
func UUID(s string) error {
	if !reUUID.MatchString(s) {
		return bad("uuid", "uuid không hợp lệ")
	}
	return nil
}

// PHPVersion kiểm cú pháp phiên bản; supported=true còn đòi phiên bản Phase 5 hỗ trợ.
func PHPVersion(v string, supported bool) error {
	if !rePHPVer.MatchString(v) {
		return bad("version", "phiên bản PHP không hợp lệ")
	}
	if supported && !PHPSupported[v] {
		return &Error{Code: "precondition_failed", Field: "version",
			Msg: "chỉ hỗ trợ PHP 8.1–8.4 (8.3 từ kho Ubuntu, còn lại từ PPA ondrej/php — D-68, D-100)"}
	}
	return nil
}

// PHPExtension kiểm extension trong allowlist.
func PHPExtension(e string) error {
	if !PHPExtensions[e] {
		return bad("extensions", "extension ngoài allowlist: %q", e)
	}
	return nil
}

// PHPFunctions kiểm danh sách disable_functions.
func PHPFunctions(fs []string) error {
	if len(fs) > 100 {
		return bad("disable_functions", "quá nhiều hàm")
	}
	for _, f := range fs {
		if !reFunc.MatchString(f) || len(f) > 64 {
			return bad("disable_functions", "tên hàm không hợp lệ: %q", f)
		}
	}
	return nil
}
