package ops_test

import (
	"regexp"
	"strings"
	"testing"

	"itso.local/agent/internal/ops"
)

// OnCalendar sinh ra chỉ gồm ký tự an toàn cho unit systemd (không xuống dòng, không %, không $, không nháy).
var reCal = regexp.MustCompile(`^((Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z.,]* )?\*-[0-9*.,]+-[0-9*.,]+ [0-9*.,]+:[0-9*.,]+:00$`)

func FuzzCronToOnCalendar(f *testing.F) {
	for _, s := range []string{"* * * * *", "*/15 2-5 * * 1-5", "0 0 29 2 *", "1,2 3-4/2 * 1-12/3 0,7", "* * 1 * 1"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		cal, err := ops.CronToOnCalendar(s)
		if err != nil {
			return
		}
		if !reCal.MatchString(cal) {
			t.Fatalf("%q → OnCalendar sai dạng %q", s, cal)
		}
	})
}

func FuzzParseSSHKey(f *testing.F) {
	f.Add("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGj2 x@y")
	f.Add(`command="sh" ssh-ed25519 AAAA`)
	f.Fuzz(func(t *testing.T, s string) {
		line, err := ops.ParseSSHKey(s)
		if err != nil {
			return
		}
		if strings.ContainsAny(line, "\n\r\x00\"") || !(strings.HasPrefix(line, "ssh-") || strings.HasPrefix(line, "ecdsa-")) {
			t.Fatalf("khóa chuẩn hóa không an toàn: %q", line)
		}
	})
}
