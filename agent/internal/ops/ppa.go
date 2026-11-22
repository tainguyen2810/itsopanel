package ops

import (
	"context"
	"crypto/sha1" //nolint:gosec // fingerprint OpenPGP v4 định nghĩa bằng SHA-1 (RFC 4880 §12.2), không dùng để bảo mật băm.
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"

	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Kho PPA ondrej/php (D-100, ADR 0045): khóa ký nhúng trong binary agent và ghim fingerprint; kho chỉ được thêm khi
// SUPER_ADMIN cài một bản PHP cần PPA (8.1/8.2/8.4). Không tải khóa từ mạng, không đụng nguồn apt khác.

//go:embed keys/ondrej-php.asc
var ondrejKey []byte

// ondrejFingerprints: khóa "Launchpad PPA for Ondřej Surý" (RSA 1024 cũ + RSA 4096 xoay năm 2024).
var ondrejFingerprints = []string{
	"14AA40EC0831756756D7F66C4F4EA0AAE5267A6C",
	"B8DC7E53946656EFBCE4C1DD71DAEAAB4AD4CAB6",
}

const (
	ppaKeyPath     = "/etc/apt/keyrings/itso-ondrej-php.asc"
	ppaSourcesPath = "/etc/apt/sources.list.d/itso-ondrej-php.sources"
)

// ppaSources là file deb822 với Signed-By riêng: khóa này chỉ có hiệu lực cho đúng kho này.
const ppaSources = `# Quản lý bởi itso-agent (D-100). Không sửa tay.
Types: deb
URIs: https://ppa.launchpadcontent.net/ondrej/php/ubuntu
Suites: noble
Components: main
Signed-By: ` + ppaKeyPath + `
`

// pgpFingerprints trả fingerprint v4 (hex chữ hoa) của mọi khóa chính trong khối ASCII-armored.
func pgpFingerprints(armored []byte) ([]string, error) {
	raw, err := dearmor(armored)
	if err != nil {
		return nil, err
	}
	var out []string
	for len(raw) > 0 {
		hdr := raw[0]
		if hdr&0x80 == 0 {
			return nil, errors.New("pgp: header gói sai")
		}
		var tag int
		var body []byte
		if hdr&0x40 != 0 { // định dạng mới
			tag = int(hdr & 0x3f)
			if len(raw) < 2 {
				return nil, errors.New("pgp: gói cụt")
			}
			var n, hl int
			switch l := int(raw[1]); {
			case l < 192:
				n, hl = l, 2
			case l < 224:
				if len(raw) < 3 {
					return nil, errors.New("pgp: gói cụt")
				}
				n, hl = (l-192)<<8+int(raw[2])+192, 3
			case l == 255:
				if len(raw) < 6 {
					return nil, errors.New("pgp: gói cụt")
				}
				n, hl = int(raw[2])<<24|int(raw[3])<<16|int(raw[4])<<8|int(raw[5]), 6
			default:
				return nil, errors.New("pgp: độ dài từng phần không hỗ trợ")
			}
			if len(raw) < hl+n {
				return nil, errors.New("pgp: gói cụt")
			}
			body, raw = raw[hl:hl+n], raw[hl+n:]
		} else { // định dạng cũ
			tag = int(hdr>>2) & 0x0f
			lt := hdr & 0x03
			sizes := map[byte]int{0: 1, 1: 2, 2: 4}
			ls, ok := sizes[lt]
			if !ok || len(raw) < 1+ls {
				return nil, errors.New("pgp: độ dài gói cũ không hỗ trợ")
			}
			n := 0
			for i := 0; i < ls; i++ {
				n = n<<8 | int(raw[1+i])
			}
			if len(raw) < 1+ls+n {
				return nil, errors.New("pgp: gói cụt")
			}
			body, raw = raw[1+ls:1+ls+n], raw[1+ls+n:]
		}
		if tag == 6 { // khóa công khai chính
			if len(body) == 0 || body[0] != 4 {
				return nil, errors.New("pgp: chỉ chấp nhận khóa v4")
			}
			h := sha1.New() //nolint:gosec // xem import
			h.Write([]byte{0x99, byte(len(body) >> 8), byte(len(body))})
			h.Write(body)
			out = append(out, strings.ToUpper(hex.EncodeToString(h.Sum(nil))))
		}
	}
	return out, nil
}

func dearmor(armored []byte) ([]byte, error) {
	s := string(armored)
	begin := strings.Index(s, "-----BEGIN PGP PUBLIC KEY BLOCK-----")
	end := strings.Index(s, "-----END PGP PUBLIC KEY BLOCK-----")
	if begin < 0 || end < begin {
		return nil, errors.New("pgp: không phải khối khóa công khai")
	}
	lines := strings.Split(s[begin:end], "\n")[1:]
	var b64 strings.Builder
	inBody := false
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if !inBody {
			if l == "" {
				inBody = true
			}
			continue
		}
		if strings.HasPrefix(l, "=") { // checksum CRC24
			break
		}
		b64.WriteString(l)
	}
	return base64.StdEncoding.DecodeString(b64.String())
}

// verifyPinnedKey: khối khóa phải chứa đúng tập fingerprint ghim (không thừa, không thiếu).
func verifyPinnedKey(armored []byte, pinned []string) error {
	got, err := pgpFingerprints(armored)
	if err != nil {
		return err
	}
	sort.Strings(got)
	want := append([]string(nil), pinned...)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		return fmt.Errorf("fingerprint khóa PPA %v khác bản ghim %v", got, want)
	}
	return nil
}

// ensurePPA ghi khóa + kho ondrej/php (idempotent) rồi apt-get update khi có thay đổi.
func (d *Deps) ensurePPA(ctx context.Context) (bool, error) {
	if err := verifyPinnedKey(ondrejKey, ondrejFingerprints); err != nil {
		return false, &registry.OpError{Code: "precondition_failed", Message: err.Error()}
	}
	changed := false
	for _, f := range []struct {
		path string
		data []byte
	}{{ppaKeyPath, ondrejKey}, {ppaSourcesPath, []byte(ppaSources)}} {
		c, err := d.FS.WriteAtomic(f.path, f.data, 0o644, platform.Owner{})
		if err != nil {
			return false, opErr(err)
		}
		changed = changed || c
	}
	if changed {
		if _, err := d.must(ctx, "dependency_unavailable", "apt-get", "update", "-q"); err != nil {
			return true, err
		}
	}
	return changed, nil
}
