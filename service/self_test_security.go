package service

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
)

var selfTestKeyMu sync.Mutex

// A stable deployment secret or a private file outside the database survives restarts.
// Multi-node installations must share SELF_TEST_ENCRYPTION_KEY (base64, 32 bytes).
func selfTestCipher() (cipher.AEAD, error) {
	selfTestKeyMu.Lock()
	defer selfTestKeyMu.Unlock()
	var key []byte
	if configured := os.Getenv("SELF_TEST_ENCRYPTION_KEY"); configured != "" {
		var err error
		key, err = base64.StdEncoding.DecodeString(configured)
		if err != nil || len(key) != 32 {
			return nil, errors.New("invalid self-test encryption key configuration")
		}
	} else if secret := os.Getenv("CRYPTO_SECRET"); secret != "" {
		digest := sha256.Sum256([]byte("new-api/self-test/v1:" + secret))
		key = digest[:]
	} else {
		name := os.Getenv("SELF_TEST_KEY_FILE")
		if name == "" {
			name = filepath.Join(filepath.Dir(common.SQLitePath), "self-test-encryption.key")
		}
		var err error
		key, err = os.ReadFile(name)
		if errors.Is(err, os.ErrNotExist) {
			key = make([]byte, 32)
			if _, err = rand.Read(key); err != nil {
				return nil, err
			}
			file, openErr := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if openErr != nil {
				return nil, errors.New("self-test key file unavailable; configure a shared encryption key")
			}
			_, err = file.Write(key)
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
		}
		if err != nil || len(key) != 32 {
			return nil, errors.New("self-test encryption key file unavailable")
		}
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func EncryptSelfTestKey(userID int, endpoint, key string) (string, error) {
	if key == "" {
		return "", errors.New("API key is required")
	}
	aead, err := selfTestCipher()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, []byte(key), []byte(fmt.Sprintf("%d:%s", userID, endpoint)))
	return "v1:" + base64.StdEncoding.EncodeToString(sealed), nil
}

func DecryptSelfTestKey(userID int, endpoint, secret string) (string, error) {
	aead, err := selfTestCipher()
	if err != nil {
		return "", err
	}
	encoded, ok := strings.CutPrefix(secret, "v1:")
	data, decodeErr := base64.StdEncoding.DecodeString(encoded)
	if !ok || decodeErr != nil || len(data) < aead.NonceSize()+aead.Overhead() {
		return "", errors.New("saved API key unavailable; enter it again")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte(fmt.Sprintf("%d:%s", userID, endpoint)))
	if err != nil {
		return "", errors.New("saved API key unavailable; enter it again")
	}
	return string(plain), nil
}

func NormalizeSelfTestURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(raw) > 1024 {
		return "", errors.New("Base URL must be a public HTTPS endpoint without credentials, query or fragment")
	}
	protection := common.SSRFProtection{ApplyIPFilterForDomain: true}
	port := 443
	if u.Port() != "" && u.Port() != "443" {
		return "", errors.New("self-test endpoints must use HTTPS port 443")
	}
	if err := protection.ValidateNetworkTarget(u.Hostname(), port); err != nil {
		return "", err
	}
	base := strings.TrimRight(u.String(), "/")
	if u.Path == "" || u.Path == "/" {
		base += "/v1"
	}
	return base, nil
}

// Always pin validated public IPs at dial time, even when relay SSRF protection is
// disabled. No environment proxy, insecure TLS override, or credential redirects.
func NewSelfTestHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	protected := &protectedFetchDialer{resolver: net.DefaultResolver, dialContext: dialer.DialContext, getProtection: func() (*common.SSRFProtection, bool, error) {
		return &common.SSRFProtection{ApplyIPFilterForDomain: true, AllowedPorts: []int{443}}, true, nil
	}}
	return &http.Client{Transport: &http.Transport{DialContext: protected.DialContext, TLSHandshakeTimeout: 15 * time.Second, IdleConnTimeout: 30 * time.Second, MaxIdleConns: 20, ForceAttemptHTTP2: true}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}

func RedactSelfTestSecret(text, key string) string {
	if key == "" {
		return text
	}
	for _, value := range []string{key, url.QueryEscape(key), url.PathEscape(key), base64.StdEncoding.EncodeToString([]byte(key))} {
		text = strings.ReplaceAll(text, value, "[REDACTED]")
	}
	encoded, _ := common.Marshal(key)
	if len(encoded) > 2 {
		text = strings.ReplaceAll(text, string(encoded[1:len(encoded)-1]), "[REDACTED]")
	}
	return text
}
