package collaboration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	projectDocumentLimit = 64 << 20
	projectResultLimit   = 96 << 20
	mergeResolutionLimit = 1 << 20
)

type ProjectTool struct {
	executable string
}

func NewProjectTool(path string) (ProjectTool, error) {
	if !filepath.IsAbs(path) {
		return ProjectTool{}, errors.New("project tool path must be absolute")
	}

	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ProjectTool{}, errors.New("project tool path is unavailable")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return ProjectTool{}, errors.New("project tool must be a regular executable")
	}

	return ProjectTool{executable: resolved}, nil
}

type ToolResult struct {
	ProtocolVersion int             `json:"protocol_version"`
	OK              bool            `json:"ok"`
	Document        json.RawMessage `json:"result"`
}

func (tool ProjectTool) Validate(ctx context.Context, project []byte) (ToolResult, error) {
	return tool.run(ctx, "validate", [][]byte{project})
}

func (tool ProjectTool) VersionManifest(ctx context.Context, project []byte) (ToolResult, error) {
	return tool.run(ctx, "version-manifest", [][]byte{project})
}

func (tool ProjectTool) MusicDiff(ctx context.Context, before, after []byte) (ToolResult, error) {
	return tool.run(ctx, "music-diff", [][]byte{before, after})
}

func (tool ProjectTool) Merge(ctx context.Context, base, left, right, resolutions []byte) (ToolResult, error) {
	inputs := [][]byte{base, left, right}
	if resolutions != nil {
		if len(resolutions) > mergeResolutionLimit {
			return ToolResult{}, errors.New("merge resolution exceeds byte limit")
		}
		inputs = append(inputs, resolutions)
	}

	return tool.run(ctx, "merge", inputs)
}

func (tool ProjectTool) run(ctx context.Context, kind string, inputs [][]byte) (ToolResult, error) {
	if tool.executable == "" {
		return ToolResult{}, errors.New("project tool is unavailable")
	}
	for _, input := range inputs {
		if len(input) == 0 || len(input) > projectDocumentLimit {
			return ToolResult{}, errors.New("project input is empty or exceeds byte limit")
		}
	}

	folder, err := os.MkdirTemp("", "ayotbi-project-")
	if err != nil {
		return ToolResult{}, err
	}
	defer os.RemoveAll(folder)

	args := []string{kind}
	names := []string{"a.json", "b.json", "c.json", "resolutions.json"}
	for i, input := range inputs {
		if err := os.WriteFile(filepath.Join(folder, names[i]), input, 0600); err != nil {
			return ToolResult{}, err
		}
		args = append(args, names[i])
	}

	timeout, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	command := exec.CommandContext(timeout, tool.executable, args...)
	command.Dir = folder
	command.Env = []string{"HOME=" + folder, "TMPDIR=" + folder, "LC_ALL=C"}
	command.WaitDelay = 2 * time.Second
	stdout := cappedBuffer{limit: projectResultLimit}
	command.Stdout = &stdout
	err = command.Run()
	if stdout.overflow {
		return ToolResult{}, errors.New("project tool result exceeds byte limit")
	}
	if err != nil && command.ProcessState == nil {
		return ToolResult{}, errors.New("project tool could not start")
	}

	var envelope struct {
		Command string `json:"command"`
		OK      *bool  `json:"ok"`
		Code    string `json:"code"`
	}
	if json.Unmarshal(stdout.buffer.Bytes(), &envelope) != nil || envelope.Command != kind || envelope.OK == nil {
		return ToolResult{}, errors.New("invalid project tool result")
	}

	exit := command.ProcessState.ExitCode()
	if (*envelope.OK && exit != 0) || (!*envelope.OK && exit != 1 && !(exit == 2 && envelope.Code == "invalid_resolution")) {
		return ToolResult{}, errors.New("project tool execution failed")
	}

	return ToolResult{ProtocolVersion: 1, OK: *envelope.OK, Document: stdout.buffer.Bytes()}, nil
}

type cappedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buffer.Len() {
		b.overflow = true
		return 0, errors.New("output limit reached")
	}

	return b.buffer.Write(p)
}
