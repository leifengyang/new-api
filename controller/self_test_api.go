package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

type selfTestGroupInput struct {
	ID              int    `json:"id"`
	Name            string `json:"name"`
	BaseURL         string `json:"base_url"`
	Model           string `json:"model"`
	Protocol        string `json:"protocol"`
	Effort          string `json:"effort"`
	MaxOutputTokens *uint  `json:"max_output_tokens"`
	APIKey          string `json:"api_key"`
	RememberKey     bool   `json:"remember_key"`
}

type selfTestInput struct {
	Groups         []selfTestGroupInput `json:"groups"`
	Prompt         string               `json:"prompt"`
	Concurrency    int                  `json:"concurrency"`
	TimeoutSeconds int                  `json:"timeout_seconds"`
}

func bindSelfTest(c *gin.Context, input any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
	if err := common.DecodeJson(c.Request.Body, input); err != nil {
		c.JSON(400, gin.H{"success": false, "message": "invalid self-test request"})
		return false
	}
	return true
}

func selfTestResponse(c *gin.Context, data any, err error) {
	if err != nil {
		c.JSON(400, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(200, gin.H{"success": true, "data": data})
}

func prepareSelfTestGroups(userID int, inputs []selfTestGroupInput, requireKey bool) ([]model.SelfTestProfile, []model.SelfTestAttempt, error) {
	if len(inputs) < 1 || len(inputs) > 10 {
		return nil, nil, errors.New("use between 1 and 10 test groups")
	}
	var saved []model.SelfTestProfile
	if err := model.DB.Where("user_id = ?", userID).Find(&saved).Error; err != nil {
		return nil, nil, err
	}
	profiles := make([]model.SelfTestProfile, 0, len(inputs))
	attempts := make([]model.SelfTestAttempt, 0, len(inputs))
	for _, input := range inputs {
		base, err := service.NormalizeSelfTestURL(input.BaseURL)
		if err != nil {
			return nil, nil, err
		}
		input.Name, input.Model = strings.TrimSpace(input.Name), strings.TrimSpace(input.Model)
		efforts := []string{"", "none", "minimal", "low", "medium", "high", "xhigh", "max"}
		// Only exact, verified model IDs have model-specific restrictions. Gateway
		// aliases may expose different capabilities; do not infer them from prefixes.
		if input.Protocol == "anthropic" || input.Model == "gpt-6.1-sol" || input.Model == "gpt-6-astra" {
			efforts = []string{"", "low", "medium", "high", "xhigh", "max"}
		}
		if !slices.Contains(efforts, input.Effort) {
			return nil, nil, errors.New("unsupported reasoning effort for this model and protocol; choose Default or a supported level")
		}
		if input.Name == "" || len(input.Name) > 128 || len(input.Model) > 128 || (requireKey && input.Model == "") || !slices.Contains([]string{"chat", "responses", "anthropic"}, input.Protocol) || len(input.APIKey) > 8192 {
			return nil, nil, errors.New("invalid group name, model, protocol, reasoning effort or key")
		}
		if input.MaxOutputTokens == nil {
			limit := uint(32768)
			input.MaxOutputTokens = &limit
		}
		if *input.MaxOutputTokens == 0 || helper.ExceedsMaxTokensLimit(input.MaxOutputTokens) {
			return nil, nil, errors.New("max_output_tokens must be between 1 and 1073741823")
		}
		key := strings.TrimSpace(input.APIKey)
		if key == "" {
			for _, existing := range saved {
				// Protocol changes may reuse this owner's key at the same endpoint.
				// Open with its saved binding, then seal for the selected protocol below.
				if existing.ID == input.ID && existing.BaseURL == base && existing.Secret != "" {
					key, err = service.DecryptSelfTestKey(userID, base+":"+existing.Protocol, string(existing.Secret))
					if err != nil {
						return nil, nil, err
					}
				}
			}
		}
		var secret string
		if key != "" {
			secret, err = service.EncryptSelfTestKey(userID, base+":"+input.Protocol, key)
		}
		if err != nil {
			return nil, nil, err
		}
		if key == "" && (requireKey || input.RememberKey) {
			return nil, nil, errors.New("enter an API key for each group")
		}
		profile := model.SelfTestProfile{UserID: userID, Name: input.Name, BaseURL: base, Model: input.Model, Protocol: input.Protocol, Effort: input.Effort, RememberKey: input.RememberKey}
		profile.MaxOutputTokens = input.MaxOutputTokens
		if input.RememberKey {
			profile.Secret = model.LongText(secret)
		}
		profiles = append(profiles, profile)
		attempts = append(attempts, model.SelfTestAttempt{Name: input.Name, BaseURL: base, Model: input.Model, Protocol: input.Protocol, Effort: input.Effort, MaxOutputTokens: input.MaxOutputTokens, Secret: model.LongText(secret)})
	}
	return profiles, attempts, nil
}

func GetSelfTestProfiles(c *gin.Context) {
	profiles := []model.SelfTestProfile{}
	err := model.DB.Where("user_id = ?", c.GetInt("id")).Order("id").Find(&profiles).Error
	for i := range profiles {
		profiles[i].HasSavedKey = profiles[i].Secret != ""
	}
	selfTestResponse(c, profiles, err)
}

func SaveSelfTestProfiles(c *gin.Context) {
	var input selfTestInput
	if !bindSelfTest(c, &input) {
		return
	}
	profiles, _, err := prepareSelfTestGroups(c.GetInt("id"), input.Groups, false)
	if err == nil {
		err = model.SaveSelfTestProfiles(c.GetInt("id"), profiles)
	}
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	GetSelfTestProfiles(c)
}

func StartSelfTest(c *gin.Context) {
	var input selfTestInput
	if !bindSelfTest(c, &input) {
		return
	}
	if input.TimeoutSeconds == 0 {
		input.TimeoutSeconds = 1200
	}
	if input.Concurrency == 0 {
		input.Concurrency = 3
	}
	if strings.TrimSpace(input.Prompt) == "" || len(input.Prompt) > 32000 || input.Concurrency < 1 || input.Concurrency > 10 || input.TimeoutSeconds < 60 || input.TimeoutSeconds > 3600 {
		selfTestResponse(c, nil, errors.New("prompt required (up to 32000 bytes); concurrency 1-10; timeout 60-3600 seconds"))
		return
	}
	profiles, attempts, err := prepareSelfTestGroups(c.GetInt("id"), input.Groups, true)
	round := model.SelfTestRound{UserID: c.GetInt("id"), Prompt: model.LongText(input.Prompt), Concurrency: input.Concurrency, TimeoutSeconds: input.TimeoutSeconds}
	if err == nil {
		err = model.CreateSelfTestRound(&round, attempts, profiles)
	}
	if err == nil {
		_, _, _ = service.EnqueueSystemTask(selfTestTaskType, nil)
	} // Scheduler also discovers durable queued attempts.
	selfTestResponse(c, round, err)
}

func GetSelfTestHistory(c *gin.Context) {
	rounds := []model.SelfTestRound{}
	err := model.DB.Where("user_id = ?", c.GetInt("id")).Omit("prompt").Order("id desc").Limit(20).Find(&rounds).Error
	selfTestResponse(c, rounds, err)
}

func GetSelfTestRound(c *gin.Context) {
	var round model.SelfTestRound
	err := model.DB.Where("user_id = ? AND id = ?", c.GetInt("id"), c.Param("id")).First(&round).Error
	if err != nil {
		c.JSON(404, gin.H{"success": false, "message": "comparison not found"})
		return
	}
	attempts := []model.SelfTestAttempt{}
	err = model.DB.Where("round_id = ? AND user_id = ?", round.ID, c.GetInt("id")).Omit("secret", "output", "html").Order("group_index, attempt").Find(&attempts).Error
	selfTestResponse(c, gin.H{"round": round, "attempts": attempts}, err)
}

func GetSelfTestAttempt(c *gin.Context) {
	var attempt model.SelfTestAttempt
	if err := model.DB.Where("user_id = ? AND id = ?", c.GetInt("id"), c.Param("id")).Omit("secret").First(&attempt).Error; err != nil {
		c.JSON(404, gin.H{"success": false, "message": "attempt not found"})
		return
	}
	selfTestResponse(c, attempt, nil)
}

func StopSelfTest(c *gin.Context) {
	var input struct {
		AttemptID int `json:"attempt_id"`
	}
	if !bindSelfTest(c, &input) {
		return
	}
	var round model.SelfTestRound
	if err := model.DB.Where("user_id = ? AND id = ?", c.GetInt("id"), c.Param("id")).First(&round).Error; err != nil {
		c.JSON(404, gin.H{"success": false, "message": "comparison not found"})
		return
	}
	query := model.DB.Model(&model.SelfTestAttempt{}).Where("user_id = ? AND round_id = ? AND status IN ?", c.GetInt("id"), round.ID, []string{"queued", "running"})
	if input.AttemptID > 0 {
		query = query.Where("id = ?", input.AttemptID)
	}
	err := query.Updates(map[string]any{"status": "cancelled", "error": "Stopped by user", "secret": ""}).Error
	if err == nil {
		err = model.FinishSelfTestRound(round.ID)
	}
	selfTestResponse(c, nil, err)
}

func RetrySelfTest(c *gin.Context) {
	var input struct {
		APIKey string `json:"api_key"`
	}
	if !bindSelfTest(c, &input) {
		return
	}
	var previous model.SelfTestAttempt
	if err := model.DB.Where("user_id = ? AND id = ?", c.GetInt("id"), c.Param("id")).First(&previous).Error; err != nil {
		c.JSON(404, gin.H{"success": false, "message": "attempt not found"})
		return
	}
	secret := string(previous.Secret)
	if input.APIKey != "" {
		if len(input.APIKey) > 8192 {
			selfTestResponse(c, nil, errors.New("invalid API key"))
			return
		}
		var err error
		secret, err = service.EncryptSelfTestKey(c.GetInt("id"), previous.BaseURL+":"+previous.Protocol, input.APIKey)
		if err != nil {
			selfTestResponse(c, nil, err)
			return
		}
	}
	if secret == "" {
		var profile model.SelfTestProfile
		model.DB.Where("user_id = ? AND base_url = ? AND protocol = ? AND name = ?", c.GetInt("id"), previous.BaseURL, previous.Protocol, previous.Name).First(&profile)
		secret = string(profile.Secret)
	}
	if secret == "" {
		selfTestResponse(c, nil, errors.New("enter the API key again to retry this group"))
		return
	}
	err := model.RetrySelfTestAttempt(c.GetInt("id"), previous.ID, model.LongText(secret))
	if err == nil {
		_, _, _ = service.EnqueueSystemTask(selfTestTaskType, nil)
	}
	selfTestResponse(c, nil, err)
}

func FetchSelfTestModels(c *gin.Context) {
	var input selfTestGroupInput
	if !bindSelfTest(c, &input) {
		return
	}
	fetchDiagnosticModels(c, input)
}

func fetchDiagnosticModels(c *gin.Context, input selfTestGroupInput) {
	// Model discovery does not depend on generation settings being complete.
	input.Effort, input.MaxOutputTokens = "", nil
	if input.Name == "" {
		input.Name = "models"
	}
	if input.Model == "" {
		input.Model = "models"
	}
	_, attempts, err := prepareSelfTestGroups(c.GetInt("id"), []selfTestGroupInput{input}, true)
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	key, err := service.DecryptSelfTestKey(c.GetInt("id"), attempts[0].BaseURL+":"+input.Protocol, string(attempts[0].Secret))
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, attempts[0].BaseURL+"/models", nil)
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	setSelfTestAuthentication(req, input.Protocol, key)
	res, err := selfTestClient.Do(req)
	if err != nil {
		selfTestResponse(c, nil, errors.New(service.RedactSelfTestSecret(err.Error(), key)))
		return
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	if res.StatusCode != 200 {
		selfTestResponse(c, nil, errors.New("HTTP "+strconv.Itoa(res.StatusCode)+": "+service.RedactSelfTestSecret(string(body), key)))
		return
	}
	models := []string{}
	for _, item := range gjson.GetBytes(body, "data").Array() {
		if id := item.Get("id").String(); id != "" && len(models) < 2000 {
			models = append(models, id)
		}
	}
	slices.Sort(models)
	selfTestResponse(c, models, nil)
}
