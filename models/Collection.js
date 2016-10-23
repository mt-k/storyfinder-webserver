var DatasourceMysql = require('../datasources/mysql.js')
	, async = require('async')
	, _ = require('lodash')
	;
	
module.exports = function(db){
	//console.log('Collection');
	var name = 'Collection'
		, table = 'collections'
		, datasource = new DatasourceMysql(db, name, table)
		;
	
	function findById(id, callback){
		datasource.find(_.isArray(id)?'all':'first', {
			fields: ['id', 'user_id', 'is_default', 'name', 'created', 'modified'],
			conditions: {
				id: id,
				is_deleted: 0
			},
			order: 'name ASC'
		}, (err, result) => {
			if(err)
				return setImmediate(() => callback(err));
			
			setImmediate(() => callback(null, result));
		});
	}
	
	this.findById = findById;
		
	function getDefault(userId, callback){
		datasource.find('first', {
			fields: ['id'],
			conditions: {
				user_id: userId,
				is_default: 1,
				is_deleted: 0
			}
		}, (err, result) => {
			if(err)
				return setImmediate(() => callback(err));
			
			if(result == null)
				return setImmediate(() => callback(new Error('User ' + userId + ' has no default collection')));
			
			setImmediate(() => callback(null, result));
		});
	}
	
	this.getDefault = getDefault;
}
