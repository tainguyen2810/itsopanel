// Package validate kiểm lại tham số ở tầng Go (không tin panel, kể cả khi schema đã kiểm).
// Mọi giá trị đi vào argv hoặc file cấu hình phải qua đây.
package validate

import (
	"fmt"
	"regexp"
	"strings"
)

// UIDMin, UIDMax là dải UID hosting account (D-45).
const (
	UIDMin = 20000
	UIDMax = 59999
)

var (
	reUsername = regexp.MustCompile(`^[a-z][a-z0-9]{2,15}$`)
	reHostname = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	reSlice    = regexp.MustCompile(`^itso-acct-[0-9]{5}\.slice$`)
)

// reserved: username hệ thống/dịch vụ/cloud image (rộng hơn danh sách trong schema).
var reserved = map[string]bool{}

func init() {
	for _, u := range strings.Fields(`root admin www mysql postgres redis nginx itso daemon bin sys sync games man mail
	news proxy backup list nobody systemd sshd ftp test user support ubuntu debian centos ec2user azureuser lxd
	irc gnats uucp messagebus syslog uuidd tcpdump landscape pollinate fwupd polkitd dnsmasq tss usbmux apt
	clamav postfix dovecot opendkim memcached mongodb elastic docker containerd frankenphp caddy`) {
		reserved[u] = true
	}
}

// Error là lỗi tham số (map sang mã invalid_params hoặc reserved_name).
type Error struct {
	Code  string
	Field string
	Msg   string
}

func (e *Error) Error() string { return e.Code + ": " + e.Field + ": " + e.Msg }

func bad(field, format string, a ...any) error {
	return &Error{Code: "invalid_params", Field: field, Msg: fmt.Sprintf(format, a...)}
}

// Username kiểm username Linux của hosting account.
func Username(u string) error {
	if !reUsername.MatchString(u) {
		return bad("username", "không hợp lệ")
	}
	if reserved[u] {
		return &Error{Code: "reserved_name", Field: "username", Msg: "tên dành cho hệ thống"}
	}
	return nil
}

// UID kiểm UID trong dải hosting.
func UID(uid int64) error {
	if uid < UIDMin || uid > UIDMax {
		return bad("uid", "ngoài dải %d–%d", UIDMin, UIDMax)
	}
	return nil
}

// Hostname kiểm hostname RFC 1123 chữ thường, tổng ≤ 253.
func Hostname(h string) error {
	if len(h) == 0 || len(h) > 253 || !reHostname.MatchString(h) {
		return bad("hostname", "không hợp lệ")
	}
	return nil
}

// SliceName trả tên slice của account theo UID (ADR 0011).
func SliceName(uid int64) (string, error) {
	if err := UID(uid); err != nil {
		return "", err
	}
	s := fmt.Sprintf("itso-acct-%d.slice", uid)
	if !reSlice.MatchString(s) {
		return "", bad("uid", "tên slice sai")
	}
	return s, nil
}

// Services là allowlist dịch vụ điều khiển được (khớp ServiceName trong contracts).
var Services = map[string]bool{"nginx": true, "php8.1-fpm": true, "php8.2-fpm": true, "php8.3-fpm": true,
	"php8.4-fpm": true, "mariadb": true, "postgresql": true, "redis-server": true, "fail2ban": true, "cron": true,
	"ssh": true, "itso-gateway": true}

// Service kiểm tên dịch vụ trong allowlist.
func Service(name string) error {
	if !Services[name] {
		return bad("name", "dịch vụ ngoài allowlist")
	}
	return nil
}

// Recipes là allowlist recipe phần mềm → gói apt (Phase 4: gói nền).
var Recipes = map[string][]string{
	"acl":       {"acl"},
	"quota":     {"quota"},
	"nftables":  {"nftables"},
	"restic":    {"restic"},
	"stress-ng": {"stress-ng"},
}

// Recipe trả danh sách gói apt của recipe.
func Recipe(name string) ([]string, error) {
	p, ok := Recipes[name]
	if !ok {
		return nil, bad("recipe", "recipe ngoài allowlist")
	}
	return p, nil
}

// Limits là giới hạn gói (khớp defs Limits).
type Limits struct {
	DiskMB     int64  `json:"disk_mb"`
	InodeLimit int64  `json:"inode_limit"`
	CPUPercent int64  `json:"cpu_percent"`
	RAMMB      int64  `json:"ram_mb"`
	TasksMax   int64  `json:"tasks_max"`
	IOWeight   int64  `json:"io_weight"`
	IOReadBps  *int64 `json:"io_read_bps"`
	IOWriteBps *int64 `json:"io_write_bps"`
}

// Check kiểm khoảng giá trị (giống schema, phòng khi schema bị nới).
func (l Limits) Check() error {
	switch {
	case l.DiskMB < 1 || l.DiskMB > 1<<24:
		return bad("limits.disk_mb", "ngoài khoảng")
	case l.InodeLimit < 1 || l.InodeLimit > 1<<32:
		return bad("limits.inode_limit", "ngoài khoảng")
	case l.CPUPercent < 1 || l.CPUPercent > 6400:
		return bad("limits.cpu_percent", "ngoài khoảng")
	case l.RAMMB < 64 || l.RAMMB > 1<<22:
		return bad("limits.ram_mb", "ngoài khoảng")
	case l.TasksMax < 16 || l.TasksMax > 1<<20:
		return bad("limits.tasks_max", "ngoài khoảng")
	case l.IOWeight < 1 || l.IOWeight > 10000:
		return bad("limits.io_weight", "ngoài khoảng")
	case l.IOReadBps != nil && *l.IOReadBps < 1, l.IOWriteBps != nil && *l.IOWriteBps < 1:
		return bad("limits.io_bps", "phải ≥ 1")
	}
	return nil
}
