package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	importsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/importer"
)

// ImportService is the controller-facing import service contract.
type ImportService interface {
	Validate(ctx context.Context, in importsvc.ImportValidationInput) (importsvc.ImportValidationResult, error)
	PrepareGit(ctx context.Context, in importsvc.GitPreparationInput) (importsvc.GitPreparationResult, error)
}

// ImportController owns the /import routes.
type ImportController struct {
	Svc ImportService
}

// Register mounts import REST routes on the supplied router.
func (c *ImportController) Register(r chi.Router) {
	r.Post("/imports/validate", c.validate)
	r.Post("/imports/prepare-git", c.prepareGit)
}

func (c *ImportController) validate(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/imports/validate")
		return
	}
	var in importsvc.ImportValidationInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := c.Svc.Validate(r.Context(), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *ImportController) prepareGit(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/imports/prepare-git")
		return
	}
	var in importsvc.GitPreparationInput
	if err := decodeJSONStrict(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := c.Svc.PrepareGit(r.Context(), in)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}
