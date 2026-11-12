package collaboration

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	gitPackLimit     = 256 << 20
	gitTransferLimit = 5 * time.Minute
)

type GitConfig struct {
	Root       string
	Executable string
}

type GitRepositories struct {
	root    string
	git     string
	backend string
	slots   chan struct{}
}

func NewGitRepositories(ctx context.Context, config GitConfig) (*GitRepositories, error) {
	if !filepath.IsAbs(config.Root) || !filepath.IsAbs(config.Executable) {
		return nil, errors.New("Git repository root and executable must be absolute paths")
	}
	if err := os.MkdirAll(config.Root, 0700); err != nil {
		return nil, errors.New("could not create Git repository root")
	}

	root, err := filepath.EvalSymlinks(config.Root)
	if err != nil {
		return nil, errors.New("could not resolve Git repository root")
	}
	stat, err := os.Stat(root)
	if err != nil || !stat.IsDir() || stat.Mode().Perm()&0077 != 0 {
		return nil, errors.New("Git repository root must be a private directory")
	}

	repositories := &GitRepositories{root: root, git: config.Executable, slots: make(chan struct{}, 4)}
	output, err := repositories.run(ctx, root, "--exec-path")
	path := strings.TrimSpace(string(output))
	if err != nil || !filepath.IsAbs(path) {
		return nil, errors.New("could not resolve Git executable directory")
	}

	repositories.backend = filepath.Join(path, "git-http-backend")
	info, err := os.Stat(repositories.backend)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return nil, errors.New("git-http-backend is unavailable")
	}

	return repositories, nil
}

func gitCommand(ctx context.Context, executable, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = dir
	cmd.Env = []string{"LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_NO_REPLACE_OBJECTS=1"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return os.ErrProcessDone
			}
			return err
		}

		return nil
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

func (g *GitRepositories) run(ctx context.Context, directory string, args ...string) ([]byte, error) {
	command := gitCommand(ctx, g.git, directory, args...)
	output := cappedBuffer{limit: 4 << 20}
	command.Stdout = &output
	if err := command.Run(); err != nil {
		return nil, err
	}

	return output.buffer.Bytes(), nil
}

func (g *GitRepositories) repository(ctx context.Context, projectID string) (string, error) {
	if !uuidPattern.MatchString(projectID) {
		return "", errors.New("invalid repository identifier")
	}

	path := filepath.Join(g.root, projectID+".git")
	if exists, err := bareRepository(path); exists || err != nil {
		return path, err
	}

	staging, err := os.MkdirTemp(g.root, ".provision-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)

	if _, err := g.run(ctx, staging, "init", "--bare", "--initial-branch=main", "--object-format=sha1", "--template=", "."); err != nil {
		return "", err
	}

	policy := `[http]
 getanyfile = false
 receivepack = true
[receive]
 fsckObjects = true
 denyNonFastForwards = true
 maxInputSize = 268435456
`
	config, err := os.OpenFile(filepath.Join(staging, "config"), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return "", err
	}
	_, writeErr := config.WriteString(policy)
	if err := errors.Join(writeErr, config.Close()); err != nil {
		return "", err
	}

	if err := os.Rename(staging, path); err != nil {
		if exists, check := bareRepository(path); !exists || check != nil {
			return "", err
		}
	}

	return path, nil
}

func bareRepository(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return false, errors.New("repository directory is not private")
	}

	head, err := os.Lstat(filepath.Join(path, "HEAD"))
	if err != nil || !head.Mode().IsRegular() {
		return false, errors.New("repository HEAD is unavailable")
	}

	return true, nil
}
