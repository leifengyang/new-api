package router

import (
	"crypto/rand"
	"errors"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

var versionedWebAssetName = regexp.MustCompile(`\.[a-fA-F0-9]{8,64}\.[a-zA-Z0-9]+$`)

func isVersionedWebAsset(name string) bool {
	return fs.ValidPath(name) && !strings.Contains(name, `\`) && strings.HasPrefix(name, "static/") &&
		versionedWebAssetName.MatchString(path.Base(name)) && isWebAssetExtension(path.Ext(name)) && path.Ext(name) != ".map"
}

// Persist only public, content-hashed build assets in a dedicated directory on
// the existing data volume. Keep retired assets for seven days after the next
// release starts, even when the previous release ran for longer than a week.
// HTML, source maps, uploads and unversioned files are never archived or served.
func archiveWebAssets(build fs.FS, directory string, now time.Time) error {
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	var previous []string
	manifest, err := root.ReadFile("active.json")
	if err == nil {
		if err := common.Unmarshal(manifest, &previous); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for _, name := range previous {
		if isVersionedWebAsset(name) {
			if err := root.Chtimes(name, now, now); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	var current []string
	err = fs.WalkDir(build, "static", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() || !isVersionedWebAsset(name) {
			return nil
		}
		if _, err := root.Stat(name); errors.Is(err, fs.ErrNotExist) {
			content, err := fs.ReadFile(build, name)
			if err != nil {
				return err
			}
			if err := root.MkdirAll(path.Dir(name), 0o755); err != nil {
				return err
			}
			if err := writeArchivedWebAsset(root, name, content); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if err := root.Chtimes(name, now, now); err != nil {
			return err
		}
		current = append(current, name)
		return nil
	})
	if err != nil {
		return err
	}
	manifest, err = common.Marshal(current)
	if err != nil {
		return err
	}
	if err := writeArchivedWebAsset(root, "active.json", manifest); err != nil {
		return err
	}
	return fs.WalkDir(root.FS(), "static", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() || !isVersionedWebAsset(name) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.ModTime().Before(now.Add(-7 * 24 * time.Hour)) {
			return root.Remove(name)
		}
		return nil
	})
}

func writeArchivedWebAsset(root *os.Root, name string, content []byte) error {
	temporary := name + "." + rand.Text() + ".tmp"
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	_, writeErr := file.Write(content)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(temporary, name)
}
