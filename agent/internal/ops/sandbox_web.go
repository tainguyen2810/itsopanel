package ops

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/platform"
)

// SimFailDomainPrefix: vhost có server_name bắt đầu bằng tiền tố này làm `nginx -t` mô phỏng thất bại
// (kiểm hoàn tác trong test, sandbox và e2e).
const SimFailDomainPrefix = "nginx-test-fail."

// SimACMEFailPrefix: domain bắt đầu bằng tiền tố này làm lego mô phỏng thất bại (domain chưa trỏ về máy).
const SimACMEFailPrefix = "acme-fail."

// nginxTest mô phỏng `nginx -t`: lỗi khi một vhost chứa domain ép lỗi hoặc ngoặc lệch.
func (s *Sim) nginxTest() platform.Result {
	names, _ := s.FS.ReadDir(VhostDir)
	for _, n := range names {
		b, err := s.FS.ReadFile(VhostDir + "/" + n)
		if err != nil {
			continue
		}
		c := string(b)
		if strings.Count(c, "{") != strings.Count(c, "}") {
			return fail(1, "nginx: [emerg] unexpected end of file, expecting \"}\" in "+VhostDir+"/"+n)
		}
		for i, l := range strings.Split(c, "\n") {
			if f := strings.Fields(l); len(f) > 1 && f[0] == "server_name" && strings.Contains(l, " "+SimFailDomainPrefix) {
				return fail(1, "nginx: [emerg] (sandbox) invalid server_name in "+VhostDir+"/"+n+":"+strconv.Itoa(i+1)+"\nnginx: configuration file /etc/nginx/nginx.conf test failed")
			}
		}
	}
	return platform.Result{Stderr: []byte("nginx: configuration file /etc/nginx/nginx.conf test is successful\n")}
}

// lego mô phỏng cấp chứng chỉ: sinh chứng chỉ tự ký (ECDSA P-256, 90 ngày) vào <path>/certificates/.
func (s *Sim) lego(c platform.Cmd) platform.Result {
	var path string
	var doms []string
	for _, a := range c.Args {
		switch {
		case strings.HasPrefix(a, "--path="):
			path = strings.TrimPrefix(a, "--path=")
		case strings.HasPrefix(a, "--domains="):
			doms = append(doms, strings.TrimPrefix(a, "--domains="))
		}
	}
	if path == "" || len(doms) == 0 {
		return fail(1, "lego: thiếu --path/--domains")
	}
	for _, d := range doms {
		if strings.HasPrefix(d, SimACMEFailPrefix) {
			return fail(1, "lego: [ERROR] (sandbox) "+d+": acme: error: 403 :: urn:ietf:params:acme:error:unauthorized :: Invalid response from http://"+d+"/.well-known/acme-challenge/x")
		}
	}
	chain, key, err := SelfSigned(doms, "ITSO Sandbox ACME CA", time.Now())
	if err != nil {
		return fail(1, err.Error())
	}
	if err := s.FS.MkdirAll(path + "/certificates"); err != nil {
		return fail(1, err.Error())
	}
	if _, err := s.FS.WriteAtomic(path+"/certificates/"+doms[0]+".crt", chain, 0o644, platform.Owner{}); err != nil {
		return fail(1, err.Error())
	}
	if _, err := s.FS.WriteAtomic(path+"/certificates/"+doms[0]+".key", key, 0o600, platform.Owner{}); err != nil {
		return fail(1, err.Error())
	}
	return ok("")
}

// SelfSigned sinh chứng chỉ tự ký cho domains (sandbox, test).
func SelfSigned(doms []string, issuer string, now time.Time) (chain, key []byte, err error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return nil, nil, err
	}
	tpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: doms[0]}, Issuer: pkix.Name{CommonName: issuer},
		DNSNames: doms, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(90 * 24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	// Tự ký: Issuer thực tế = Subject; dùng CA giả để issuer hiển thị đúng tên.
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: issuer}, NotBefore: now.Add(-time.Hour),
		NotAfter: now.Add(365 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca, &k.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	kd, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, nil, err
	}
	chain = append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	return chain, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kd}), nil
}
