package collaboration

import (
	"net/url"
	"regexp"
	"strings"
)

var projectReturnPath = regexp.MustCompile(`^/projects/[a-fA-F0-9-]+(?:/(?:media(?:/[a-fA-F0-9-]+/versions/[a-fA-F0-9-]+)?|tasks(?:/[a-fA-F0-9-]+)?|activity|settings))?$`)

func safeWebReturn(raw string) bool {
	if safeReviewReturn(raw) {
		return true
	}
	if len(raw) > 2048 || strings.ContainsAny(raw, "\\\r\n\t") {
		return false
	}

	target, err := url.Parse(raw)
	if err != nil || target.IsAbs() || target.Host != "" || target.RawPath != "" || target.ForceQuery {
		return false
	}

	fragment := target.Fragment
	if fragment != "" && fragment != "task-board" &&
		(!strings.HasPrefix(fragment, "note-") || !uuidPattern.MatchString(strings.TrimPrefix(fragment, "note-"))) {
		return false
	}

	switch target.Path {
	case "/", "/projects", "/work":
	default:
		if !projectReturnPath.MatchString(target.Path) {
			return false
		}
		for index, part := range strings.Split(target.Path, "/") {
			if (index == 2 || index == 4 || index == 6) && !uuidPattern.MatchString(part) {
				return false
			}
		}
	}

	query, err := url.ParseQuery(target.RawQuery)
	if err != nil {
		return false
	}
	for key, values := range query {
		if len(values) != 1 || !safeWebReturnValue(key, values[0]) {
			return false
		}
	}
	return true
}

func safeWebReturnValue(key, value string) bool {
	switch key {
	case "project", "version", "note", "task_note", "assignee":
		return uuidPattern.MatchString(value)
	case "at":
		return len(value) <= 10 && value != "" && strings.Trim(value, "0123456789") == ""
	case "view":
		return value == "list" || value == "board"
	case "filter":
		return value == "assigned" || value == "review" || value == "due" || value == "late"
	case "status":
		return value == "todo" || value == "progress" || value == "review" || value == "done"
	case "archived":
		return value == "true" || value == "false"
	case "q", "due", "type":
		return len(value) <= 200 && !strings.ContainsAny(value, "\r\n\x00")
	default:
		return false
	}
}
