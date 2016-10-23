var _ = require('lodash')
	, async = require('async')
	, fs = require('fs')
	, crypto = require('crypto')
	, path = require('path')
	, ensureLoggedIn = require('connect-ensure-login').ensureLoggedIn
	, colorThief = new (require('color-thief'))()
	;
	
module.exports = function(connection, app, passport, io){
	var User = new (require('../models/User.js'))(connection)
		, Site = new (require('../models/Site.js'))(connection)
		, Article = new (require('../models/Article.js'))(connection)
		, Entity = new (require('../models/Entity.js'))(connection)
		, Collection = new (require('../models/Collection.js'))(connection)
		, Ngram = new (require('../models/Ngram.js'))(connection)
		, GermanerComponent = new (require('./components/GermanerComponent'))({
				port: "8080",
				host: "germaner"
			})
		, CorenlpComponent = new (require('./components/CorenlpComponent'))({
				port: "9000",
				host: "corenlp"
			}, {
				"pos.model": "edu/stanford/nlp/models/pos-tagger/german/german-hgc.tagger",
				"outputFormat": "json"
			})
		, StopwordComponent = new (require('./components/StopwordComponent.js'))()
		, KeywordComponent = new (require('./components/KeywordComponent.js'))(Ngram, Article)
		;
		
	app.get('/Sites', ensureLoggedIn('/login'), function (req, res) {
		var page = _.isEmpty(req.query.page)?0:req.query.page
			, userId = req.user.id
			;
						
		async.waterfall([
			/*
			Get the id of user's default collection	
			*/
			(next) => {
				Collection.getDefault(userId, 
					(err, collection) => {
						if(err)return setImmediate(() => next(err));
						
						setImmediate(() => next(null, {
							Collection: collection
						}))
					}
				);
			},
			/*
			Get the sites in the collection	
			*/
			(memo, next) => {
				Site.getAll(memo.Collection.id, page,
					(err, sites) => {
						if(err)return setImmediate(() => next(err));
						
						memo.Sites = sites;
						
						setImmediate(() => next(null, memo));
					}
				);
			}
		], 
		(err, result) => {
			if(err){
				console.log(err);
				return setImmediate(() => res.sendStatus(500));
			}
			
			console.log(result);
			
			res.send(result);
		});
	});
	
	/*
	Add a new site
	The method gets called by the plugin -> Use http auth instead of sessions and supply the credentials with every request
	
	Truncate:
		Truncate `articles`;
		Truncate `articles_entities`;
		Truncate `changelogs`;
		Truncate `changelogs_updates`;
		Truncate `entities`;
		Truncate `entities_sentences`;
		Truncate `ngrams`;
		Truncate `relations`;
		Truncate `relations_sentences`;
		Truncate `sentences`;
		Truncate `sites`;
		Truncate `visits`;
	*/
	app.put('/Sites', passport.authenticate('basic', {session: false}), function (req, res) {
		var userId = req.user.id
			;
		
		io.emit('parsing_site', null);
				
		async.waterfall([
			(next) => setImmediate(() => next(null, {
				user_id: userId,
				data: req.body			
			})),
			_mGetCollection, //Get the id of user's default collection
			_mGetOrAddSite, //Load the site if it's already registered or create a new site
			_mRegisterVisit //Register the visit
		], 
		(err, result) => {
			if(err){
				console.log(err);
				return setImmediate(() => res.sendStatus(500));
			}
						
			delete result.data;
			
			console.log(result);
			
			if(_.isUndefined(result.is_parseable) || result.is_parseable)	
				io.emit('new_site', result);
			else
				io.emit('done_parsing_site', null);
			
			res.send(result);
		});
	});
	
	app.put('/Sites/:siteId/image', passport.authenticate('basic', {session: false}), function(req, res){
		var userId = req.user.id
			, siteId = req.params.siteId
			, img = req.body.image.replace(/^data:image\/png;base64,/, "")
			;
		
		async.waterfall([
			(next) => setImmediate(() => next(null, {
				user_id: userId			
			})),
			_mGetCollection, //Get the id of user's default collection
			(memo, next) => {
				async.reduce(['..', 'public', 'images', '/' + memo.Collection.id, 'sites'], __dirname, (p, folder, nextFolder) => {
					p = path.join(p, folder);

					fs.stat(p, (err, stats) => {
						if(err && err.code == 'ENOENT') {
							fs.mkdir(p, (err) => {
								if(err)return setImmediate(() => nextFolder(err));
								
								setImmediate(() => nextFolder(null, p));
							});
						}else if(err){
							return setImmediate(() => nextFolder(err));
						}else{
							return setImmediate(() => nextFolder(null, p));
						}
					});
				}, (err, p) => {
					if(err)return setImmediate(() => next(err));
					
					memo.path = p;
					setImmediate(() => next(null, memo));
				});
			},
			(memo, next) => {
				var p = path.join(memo.path, siteId + '.png');
				fs.writeFile(p, img, 'base64', function(err){
					if(err)return setImmediate(() => next(err));
					
					memo.path = p;
					
					setImmediate(() => next(null, memo));
				});
			},
			(memo, next) => {
				fs.readFile(memo.path, (err, fileContent) => {
					if(err)return setImmediate(() => next(err));
					
					var rgb = colorThief.getColor(fileContent);
					var hex = _decimalToHex(rgb[0]) + _decimalToHex(rgb[1]) + _decimalToHex(rgb[2]);
					
					Site.setColor(siteId, hex, memo.user_id, (err) => {
						if(err)return setImmediate(() => next(err));
						
						memo.primary_color = hex;
						
						setImmediate(() => next(null, memo));
					});
				});
			}
		], 
		(err, result) => {
			if(err){
				console.log(err);
				res.sendStatus(500);
				return false;
			}
			
			res.send({
				success: true
			});
		});
	});
	
		function _decimalToHex(d, padding) {
		    var hex = Number(d).toString(16);
		    padding = typeof (padding) === "undefined" || padding === null ? padding = 2 : padding;
		
		    while (hex.length < padding)
		        hex = "0" + hex;
		
		    return hex;
		}
	
		function _isSiteRelevant(data, callback){			
			//if the field data.Site.isRelevant is set to true than the site is marked as relevant by the user
			if(data.Article.isRelevant)return setImmediate(() => callback(null, true));
			
			var rows = _.filter(data.Article.plain.split('\n'), (row) => {
				row = row.replace(/^\s+/g,'').replace(/\s+$/g,'');
		
				if(row.length == 0)return false;
				
				var cntAlphanumeric = row.length - row.replace(/[A-Za-z\-\,\.\?\s]/g,'').length;
				var ratioAlphanumeric = 1 / row.length * cntAlphanumeric;

				if(ratioAlphanumeric < 0.95)return false;
				if(row.indexOf('.') == -1 && row.indexOf('!') == -1 && row.indexOf('?') == -1)return false;
				var tokens = row.split(/\s+/);
				if(tokens < 10)return false;
				
				return true;
			});
			
			var score = 1 / data.Article.plain.replace(/\s/g).length * rows.join('').replace(/\s/g).length;
			
			if(score > 0.3)
				setImmediate(() => callback(null, true));
			else
				setImmediate(() => callback(null, false));
		}
	
		function _getOccurances(memo, candidate){
			var occurances = 0;
			
			memo.data.ngrams[0][candidate.value].forEach(occurance => {
				//check length of sentence
				var sentence = memo.data.sentences[occurance.sentence];
				var n = candidate.tokens;
								
				if(sentence.tokens.length - occurance.idx < n)return null;
				
				//Get n tokens
				var ngram = []
					, multiword = []
					;
				
				sentence.tokens.slice(occurance.idx, occurance.idx + n).forEach(token => {
					/*ngram.push({
						sentence: occurance.sentence,
						idx: occurence.idx
					});
					*/
					multiword.push(token.originalText);
				});
				
				multiword = multiword.join(' ');
				
				if(n > 3){
					console.log(multiword, candidate.caption);
				}
				
				if(multiword != candidate.caption)return null;
				
				occurances++;
				
				//Found match				
				if(_.isUndefined(memo.data.ngrams[n - 1]))
					memo.data.ngrams[n - 1] = {};
				
				(memo.data.ngrams[n - 1][multiword] || (memo.data.ngrams[n - 1][multiword] = [])).push({
						sentence: occurance.sentence,
						idx: occurance.idx
					});
			});
			
			return occurances;
		}
	
	/*
		Memo functions	
	*/
		/*
		Get the id of user's default collection	
		*/
		function _mGetCollection(memo, next){
			Collection.getDefault(memo.user_id, 
				(err, collection) => {
					if(err)return setImmediate(() => next(err));
					
					memo.Collection = collection;
					
					setImmediate(() => next(null, memo))
				}
			);
		}
		
		/*
		Get a site or create one	
		*/
		function _mGetOrAddSite(memo, next){
			//Create an md5 hash of the article content
			//console.log(memo.data.Article.plain);
					
			//console.log(memo.data.Site.hash);
							
			if(!_.isUndefined(memo.data.Article.isParseable) && memo.data.Article.isParseable == false)
				return setImmediate(() => next(null, {
					is_parseable: false
				}));
				
			memo.data.Site.hash = crypto.createHash('md5').update(memo.data.Article.plain).digest('hex');
			
			Site.findByUrl(memo.data.Site.url, memo.Collection.id, memo.data.Article.plain, {
				withArticle: true,
				withEntities: true,
				withRelations: false
			}, (err, site) => {				
				if(err)return setImmediate(() => next(err));
				
				if(!_.isEmpty(site)){
					console.log('Found site ' + memo.data.Site.url)
					site.is_relevant = true;
					memo.Site = site;
					memo.is_new = memo.is_new || false;
					return setImmediate(() => next(null, memo))
				}
				
				//Site doesn't exist => check if the site is relevant
				_isSiteRelevant(memo.data, (err, bIsRelevant) => {
					if(err)return setImmediate(() => next(err));
										
					if(!bIsRelevant){
						console.log('Site is not relevant');
						//Site is not relevant => stop here
						memo.is_relevant = false;
						memo.is_new = true;
						return setImmediate(() => next(null, memo))
					}
					
					memo.is_relevant = true;
					memo.is_new = true;
					
					console.log('Site is relevant');
					
					//Site is relevant => add to database
					async.waterfall([
						(nextParse) => setImmediate(() => nextParse(null, memo)),
						_mParseOpenNLP,
						_mFindEntities,
						_mExtractNamedEntities,
						_mFilterStopwords,
						_mExtractKeywords,
						_mExtractRelations,
						_mAddSite,
						_mGetOrAddSite
					], next);
				});
			});
		}
		
		/*
		Parse site using OpenNLP
		
		The methods adds the following elements to memo.data
		- sentences: An array of all sentences in the article
		- ngrams: An array with [0] mono-, [1] bi- and [2] trigrams
		*/
		function _mParseOpenNLP(memo, next){
			tokens = [];
		
			//console.log(memo.data.Article.plain);
		
			CorenlpComponent.parse(memo.data.Article.plain, {annotators: 'tokenize,ssplit,pos,lemma'}, (err, results) => {	
				if(err)return setImmediate(() => next(err));
				
				if(_.isUndefined(results))return setImmediate(() => next(new Error('Unable to parse article')));
				
				memo.data.ngrams = [{}, {}, {}];				
				var sentences = _.reject(results.sentences, _.isUndefined);
				
				memo.data.sentences = sentences.map((sentence, sentenceIdx) => {
					sentence.text = _.map(sentence.tokens, 'originalText').join(' ');
					//console.log(sentence.text);
					sentence.tokens.forEach((t, i) => {
						var ngram = [];
						
						//Build n-grams
						for(var n = 0; n <= Math.min(i, memo.data.ngrams.length - 1); n++){
							ngram.unshift(sentence.tokens[i - n]);
							var key = _.map(ngram, 'originalText').join(' ');
							
							(memo.data.ngrams[n][key] || (memo.data.ngrams[n][key] = [])).push({
								sentence: sentenceIdx,
								idx: i - n
							});
						}
					});
					return sentence;
				});
				
				//console.log(memo.data.ngrams);
				
				setImmediate(() => next(null, memo));
			});
		}
		
		/*
		Find entities in the article already contained in the database	
		*/
		function _mFindEntities(memo, next){
			/*
				Find all single word entities
			*/
			memo.data.Entities = {};
			console.log('Find entities');
			var mwCandidates = []; //Entities which are candidates for multiwords
			
			Entity.findByValue(_.keys(memo.data.ngrams[0]), memo.Collection.id, (err, entities) => {
				if(err)return setImmediate(() => next(err));
				if(_.isEmpty(entities))return setImmediate(() => next(null, memo));
				
				//Filter multiwords			
				entities.forEach(entity => {
					if(entity.tokens == 1)
						memo.data.Entities[entity.value] = entity;
					else
						mwCandidates.push(entity);
				});
				
				if(_.isEmpty(mwCandidates))return setImmediate(() => next(null, memo));
				
				/*
					Find multiword entities by checking all candidates	
				*/
				async.each(mwCandidates, (candidate, doneCandidate) => {
					var n = parseInt(candidate.tokens);
					
					if(n <= 3){
						//For entities with 3 or less tokens we can use a simple lookup in the n-grams array
						if(_.isUndefined(memo.data.ngrams[n - 1][candidate.multiword]))
							return setImmediate(doneCandidate);
						
						memo.data.Entities[candidate.multiword] = candidate;
						return setImmediate(doneCandidate);
					}else{
						//For entities with more than 3 tokens we have to build new n-grams
						if(_.isUndefined(memo.data.ngrams[0][candidate.value]))return setImmediate(doneCandidate);
						
						//For each occurance of the first token of the entity
						if(!_.isEmpty(_getOccurances(memo, candidate)))
							memo.data.Entities[candidate.multiword] = candidate;
							
						setImmediate(doneCandidate);
					}
				}, (err) => {
					if(err)return setImmediate(() => next(err));
					
					setImmediate(() => next(null, memo));
				});
			});
		}			
		
		/*
			Extract named entities in the article	
		*/
		function _mExtractNamedEntities(memo, next){			
			var sentences = memo.data.sentences.map(sentence => {
				return _.map(sentence.tokens, 'originalText')
			});
			
			console.log('Extract NEs');
			
			GermanerComponent.parse(sentences, (err, entities) => {
				if(err)return setImmediate(() => next(err));
				
				entities.forEach(entity => {
					if(entity.value.length > 128){
						console.log('Entity is too long', entity);
						return;
					}
					
					if(
						entity.value.indexOf('\\') != -1
						|| entity.value.indexOf('"') != -1
						|| entity.value.indexOf("'") != -1
					)return;
					
					var tokens = entity.value.split(/\s+/g);
					entity = {
						type: entity.type,
						value: tokens[0],
						tokens: tokens.length,
						multiword: (tokens.length > 1)?entity.value:null,
						caption: entity.value
					};
									
					//Add the entity to the memo array						
					if(_.isUndefined(memo.data.Entities[entity.caption])){
						memo.data.Entities[entity.caption] = entity;
					
						if(_.isUndefined(memo.data.ngrams[entity.tokens - 1]))
							memo.data.ngrams[entity.tokens - 1] = {};
						
						if(_.isUndefined(memo.data.ngrams[entity.tokens - 1][entity.caption])){
							//console.log('Adding ' + entity.caption, entity.tokens - 1);
							//The n-gram of this entity is not in memo
							_getOccurances(memo, memo.data.Entities[entity.caption]);
						}
					}
				});
				
				setImmediate(() => next(null, memo));
			});
		}
		
		/*
			Filter stopwords
		*/
		function _mFilterStopwords(memo, next){
			memo.data.ngrams.forEach((ngrams, n) => {
				var keys = _.keys(ngrams);
				keys.forEach((ngram) => {
					var tokens = ngram.split(' ');
					
					//Check if the ngram contains only stopwords					
					var containsOnlyStopwords = _.reduce(tokens, (isStopword, token, key) => {
						return isStopword && StopwordComponent.is(token);
					}, true);
					
					//Check if first or last element is stopword
					if(StopwordComponent.is(tokens[0]) || StopwordComponent.is(tokens[tokens.length - 1]))
						containsOnlyStopwords = true;
										
					//Ngram has to contain at least one character A-Za-z => Filter numbers and symbols
					if(!ngram.match(/[A-Za-z]/))
						containsOnlyStopwords = true;
					
					if(containsOnlyStopwords){
						console.log('Removing stopword: ' + ngram);
						delete ngrams[ngram];
					}					
				});
			});
			
			setImmediate(() => next(null, memo));
		}
		
		/*
			Extract keywords	
		*/
		function _mExtractKeywords(memo, next){
			async.eachOfSeries(memo.data.ngrams, (ngrams, n, nextN) => {
				var candidates = {};
				_.forOwn(ngrams, (sentences, ngram) => {
					var ngramL = ngram.toLowerCase();
					if(_.isUndefined(candidates[ngramL]))
						candidates[ngramL] = {
							length: sentences.length,
							caption: ngram
						}
					else
						candidates[ngramL].length += sentences.length;
				});
								
				KeywordComponent.getKeywords(candidates, n, memo.Collection.id, (err, keywords) => {
					var added = 0;
					if(!_.isEmpty(keywords))
						keywords.forEach(keyword => {
							if(!_.isUndefined(memo.data.Entities[keyword]))return; //skip if the keyword is already in the entity list (already in database or NE)
							if(added >= 5)return; //Add at least 5 keywords
							
							var kTokens = keyword.toLowerCase().split(' ');
							
							//Check if keyword is contained in any entity
							for(var entity in memo.data.Entities){
								var tokens = {};
								if(memo.data.Entities[entity].tokenMap)
									tokens = memo.data.Entities[entity].tokenMap;
								else{
									entity.toLowerCase().split(' ').forEach((t) => tokens[t] = true);
									memo.data.Entities[entity].tokenMap = tokens;
								}
								
								var containsToken = kTokens.reduce((b, t) => {
									return b || tokens[t] || false;
								}, false);
								
								if(containsToken){
									console.log('Part of keyword ' + keyword + ' is contained in ' + entity);
									return;
								}
							}
							added++;
							var tokens = keyword.split(' ');
							
							memo.data.Entities[keyword] = {
								type: 'KEY',
								value: tokens[0],
								tokens: tokens.length,
								multiword: (tokens.length > 1)?keyword:null,
								caption: keyword
							}
						});
					
					setImmediate(nextN);
				});
			}, (err) => {
				if(err)return setImmediate(() => next(err));
				
				setImmediate(() => next(null, memo));
			});
		}
		
		/*
			Extract relations (Cooccurrences)
		*/
		function _mExtractRelations(memo, next){
			console.log('Extraction relations');
			var _entities = _.values(memo.data.Entities);
			
			memo.data.relations = {};
			
			_entities.forEach((entity1, i) => {
				var sentences1 = {};
				
				if(_.isUndefined(memo.data.ngrams[entity1.tokens - 1]) || _.isUndefined(memo.data.ngrams[entity1.tokens - 1][entity1.caption]))return;
				
				memo.data.ngrams[entity1.tokens - 1][entity1.caption].forEach(o => sentences1[o.sentence] = true);
				
				for(i++; i < _entities.length; i++){
					var entity2 = _entities[i]
						, sentences2 = memo.data.ngrams[entity2.tokens - 1][entity2.caption]
						;
					
					if(_.isUndefined(sentences2)){
						console.log(entity2.tokens - 1, entity2.caption);
						continue;
					}
					
					sentences2.forEach(o => {
						if(_.isUndefined(sentences1[o.sentence]))return null;
						
						var key1 = (entity1.caption.localeCompare(entity2.caption) > 0)?entity2.caption:entity1.caption
							, key2 = (entity1.caption.localeCompare(entity2.caption) > 0)?entity1.caption:entity2.caption
							;
						
						if(_.isUndefined(memo.data.relations[key1]))
							memo.data.relations[key1] = {};
						
						(memo.data.relations[key1][key2] || (memo.data.relations[key1][key2] = [])).push(o.sentence);
					});
				}
			});
			
			setImmediate(() => next(null, memo));
		}
		
		/*
			Register visit	
		*/
		function _mRegisterVisit(memo, next){
			console.log('Register Visit');
			//ToDo
			setImmediate(() => next(null, memo));
		}
		
		function _mAddSite(memo, next){
			Site.add(memo, (err, result) => {
				if(err)return setImmediate(() => next(err));
				
				memo.changelog_id = result.changelog_id;
				memo.data.Site.id = result.id;
				
				console.log('Site added');
				
				setImmediate(() => next(null, memo));
			});
		}
}